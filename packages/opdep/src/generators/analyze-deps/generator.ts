import { Tree, formatFiles, getProjects } from '@nx/devkit';
import { AnalyzeDepsGeneratorSchema } from './schema';
import { Project, SyntaxKind, ts, Node } from 'ts-morph';
import * as path from 'path';
import escapeStringRegexp from 'escape-string-regexp';

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
  aliasPatterns?: string[];
}

function readJsonFromTree(tree: Tree, filePath: string): any {
  const content = tree.read(filePath, 'utf-8');
  if (!content) {
    throw new Error(`File not found: ${filePath}`);
  }
  return JSON.parse(content);
}

function writeJsonToTree(tree: Tree, filePath: string, content: any): void {
  tree.write(filePath, JSON.stringify(content, null, 2));
}

function createRegexPattern(pattern: string): RegExp {
  const escaped = escapeStringRegexp(pattern)
    .replace(/\\\*/g, '.*')
    .replace(/\\\?/g, '.');
  return new RegExp(`^${escaped}$`);
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
  const tsConfig = readJsonFromTree(tree, tsConfigPath);
  
  let paths: TsConfigPaths = {};
  
  if (tsConfig.extends) {
    const baseConfigPath = path.resolve(project.root, tsConfig.extends);
    try {
      const baseConfig = readJsonFromTree(tree, baseConfigPath);
      paths = { ...baseConfig.compilerOptions?.paths };
    } catch (error) {
      console.warn(`Warning: Could not read extended tsconfig at ${baseConfigPath}`);
    }
  }
  
  paths = {
    ...paths,
    ...(tsConfig.compilerOptions?.paths || {})
  };

  const packageJsonPath = path.join(project.root, 'package.json');
  const originalPackageJson: PackageJson = readJsonFromTree(tree, packageJsonPath);

  const internalPatterns = (options.internalModulePatterns || []).map(createRegexPattern);

  const analysisContext: ImportAnalysisContext = {
    paths,
    internalPatterns,
    packageJson: originalPackageJson,
    aliasPatterns: options.aliasPatterns
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
    const fileDir = path.dirname(sourceFile.getFilePath());
    
    const importDeclarations = sourceFile.getImportDeclarations();
    importDeclarations.forEach(importDecl => {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      analyzeImport(moduleSpecifier, analysis, fileDir, analysisContext);
    });

    const requireCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(call => {
        const expression = call.getExpression();
        const symbol = expression.getSymbol();
        
        return symbol?.getName() === 'require' &&
               symbol?.getDeclarations()?.some(d => {
                 const filePath = d.getSourceFile().getFilePath();
                 return filePath.includes('node_modules/typescript') ||
                        filePath.includes('@types/node');
               });
      });

    requireCalls.forEach(call => {
      const args = call.getArguments();
      if (args.length > 0) {
        const arg = args[0];
        if (Node.isStringLiteral(arg)) {
          const moduleSpecifier = arg.getLiteralValue();
          analyzeImport(moduleSpecifier, analysis, fileDir, analysisContext);
        }
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
  writeJsonToTree(tree, outputPath, {
    ...optimizedPackageJson,
    internalDependencies: {
      relative: Array.from(analysis.internalImports),
      alias: Array.from(analysis.internalAliasImports)
    }
  });

  await formatFiles(tree);
}

function isInternalAlias(moduleSpecifier: string, context: ImportAnalysisContext): boolean {
  if (context.aliasPatterns?.some(pattern => 
    createRegexPattern(pattern).test(moduleSpecifier)
  )) {
    return true;
  }

  for (const [alias, targets] of Object.entries(context.paths)) {
    const pattern = createRegexPattern(alias);
    if (pattern.test(moduleSpecifier)) {
      return true;
    }
  }

  if (context.internalPatterns.some(pattern => pattern.test(moduleSpecifier))) {
    return true;
  }

  const packageName = moduleSpecifier.split('/').slice(0, 2).join('/');
  return !context.packageJson.dependencies?.[packageName] &&
         !context.packageJson.devDependencies?.[packageName] &&
         !context.packageJson.peerDependencies?.[packageName];
}

function analyzeImport(
  moduleSpecifier: string, 
  analysis: DependencyAnalysis, 
  baseDir: string,
  context: ImportAnalysisContext
) {
  if (moduleSpecifier.startsWith('.') || moduleSpecifier.startsWith('/')) {
    const absolutePath = path.resolve(baseDir, moduleSpecifier);
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
