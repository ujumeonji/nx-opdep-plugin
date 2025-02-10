import { Tree, formatFiles, getProjects } from '@nx/devkit';
import { AnalyzeDepsGeneratorSchema } from './schema';
import { Project, SyntaxKind, ts } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';

interface PackageJson {
  name: string;
  version: string;
  dependencies: { [key: string]: string };
  devDependencies: { [key: string]: string };
  peerDependencies?: { [key: string]: string };
}

interface DependencyAnalysis {
  externalImports: Set<string>;
  internalImports: Set<string>;
  internalAliasImports: Set<string>;
}

interface TsConfigPaths {
  [key: string]: string[];
}

interface ImportAnalysisContext {
  paths: TsConfigPaths;
  internalPatterns: RegExp[];
  packageJson: PackageJson;
}

export async function analyzeDepsGenerator(
  tree: Tree,
  options: AnalyzeDepsGeneratorSchema
) {
  const projects = getProjects(tree);
  const project = projects.get(options.projectName);
  
  if (!project) {
    throw new Error(`Project ${options.projectName} not found`);
  }

  const tsConfigPath = path.join(project.root, 'tsconfig.json');
  const tsConfig = JSON.parse(fs.readFileSync(tsConfigPath, 'utf-8'));
  const baseConfigPath = path.resolve(project.root, tsConfig.extends || '');
  const baseConfig = fs.existsSync(baseConfigPath) 
    ? JSON.parse(fs.readFileSync(baseConfigPath, 'utf-8'))
    : { compilerOptions: { paths: {} } };

  const paths: TsConfigPaths = {
    ...(baseConfig.compilerOptions?.paths || {}),
    ...(tsConfig.compilerOptions?.paths || {})
  };

  const packageJsonPath = path.join(project.root, 'package.json');
  const originalPackageJson: PackageJson = JSON.parse(
    fs.readFileSync(packageJsonPath, 'utf-8')
  );

  // 내부 모듈 패턴을 정규식으로 변환
  const internalPatterns = (options.internalModulePatterns || []).map(pattern => {
    // 문자열 패턴을 정규식으로 변환 (e.g., "@org/*" -> "^@org/.*$")
    const regexPattern = pattern
      .replace(/\*/g, '.*')
      .replace(/\/$/, '')
      .replace(/^/, '^')
      .replace(/$/, '$');
    return new RegExp(regexPattern);
  });

  const analysisContext: ImportAnalysisContext = {
    paths,
    internalPatterns,
    packageJson: originalPackageJson
  };

  const tsProject = new Project({
    tsConfigFilePath: tsConfigPath,
  });

  const sourceFiles = tsProject.getSourceFiles();
  const analysis: DependencyAnalysis = {
    externalImports: new Set<string>(),
    internalImports: new Set<string>(),
    internalAliasImports: new Set<string>()
  };

  sourceFiles.forEach(sourceFile => {
    const importDeclarations = sourceFile.getImportDeclarations();
    
    importDeclarations.forEach(importDecl => {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      analyzeImport(moduleSpecifier, analysis, project.root, analysisContext);
    });

    const requireCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(call => {
        const expression = call.getExpression();
        return expression.getText() === 'require';
      });

    requireCalls.forEach(call => {
      const args = call.getArguments();
      if (args.length > 0) {
        const moduleSpecifier = args[0].getText().replace(/['"]/g, '');
        analyzeImport(moduleSpecifier, analysis, project.root, analysisContext);
      }
    });
  });

  const optimizedPackageJson: PackageJson = {
    name: originalPackageJson.name,
    version: originalPackageJson.version,
    dependencies: {},
    devDependencies: {},
    peerDependencies: originalPackageJson.peerDependencies || {},
  };

  analysis.externalImports.forEach(packageName => {
    if (originalPackageJson.dependencies?.[packageName]) {
      optimizedPackageJson.dependencies[packageName] =
        originalPackageJson.dependencies[packageName];
    } else if (originalPackageJson.devDependencies?.[packageName]) {
      optimizedPackageJson.devDependencies[packageName] =
        originalPackageJson.devDependencies[packageName];
    }
  });

  const outputPath = path.join(project.root, options.outputPath);
  fs.writeFileSync(
    outputPath,
    JSON.stringify({
      ...optimizedPackageJson,
      internalDependencies: {
        relative: Array.from(analysis.internalImports),
        alias: Array.from(analysis.internalAliasImports)
      }
    }, null, 2)
  );

  await formatFiles(tree);
}

function isInternalAlias(moduleSpecifier: string, context: ImportAnalysisContext): boolean {
  if (!moduleSpecifier.startsWith('@')) return false;
  
  // tsconfig paths에 정의된 alias인지 확인
  for (const [alias, targets] of Object.entries(context.paths)) {
    const pattern = alias
      .replace(/\*/g, '.*')
      .replace(/\/$/, '')
      .replace(/^/, '^')
      .replace(/$/, '$');

    if (new RegExp(pattern).test(moduleSpecifier)) {
      return true;
    }
  }

  // 사용자 정의 내부 모듈 패턴 확인
  if (context.internalPatterns.some(pattern => pattern.test(moduleSpecifier))) {
    return true;
  }

  // package.json의 dependencies에 없는 @로 시작하는 import는 내부 모듈로 간주
  const packageName = moduleSpecifier.split('/').slice(0, 2).join('/');
  return !context.packageJson.dependencies?.[packageName] &&
         !context.packageJson.devDependencies?.[packageName] &&
         !context.packageJson.peerDependencies?.[packageName];
}

function analyzeImport(
  moduleSpecifier: string, 
  analysis: DependencyAnalysis, 
  projectRoot: string,
  context: ImportAnalysisContext
) {
  if (moduleSpecifier.startsWith('.') || moduleSpecifier.startsWith('/')) {
    const absolutePath = path.resolve(projectRoot, moduleSpecifier);
    analysis.internalImports.add(absolutePath);
  } else if (isInternalAlias(moduleSpecifier, context)) {
    analysis.internalAliasImports.add(moduleSpecifier);
  } else {
    const packageName = moduleSpecifier.startsWith('@') 
      ? moduleSpecifier.split('/').slice(0, 2).join('/')
      : moduleSpecifier.split('/')[0];
    
    analysis.externalImports.add(packageName);
  }
}

export default analyzeDepsGenerator;
