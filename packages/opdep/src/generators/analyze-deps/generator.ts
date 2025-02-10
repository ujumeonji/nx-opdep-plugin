import { Tree, formatFiles, getProjects } from '@nx/devkit';
import { AnalyzeDepsGeneratorSchema } from './schema';
import { Project, SyntaxKind, ts, Node } from 'ts-morph';
import * as path from 'path';

interface PackageJson {
  name: string;
  version: string;
  dependencies: { [key: string]: string };
  devDependencies: { [key: string]: string };
  peerDependencies?: { [key: string]: string };
}

interface DependencyAnalysis {
  externalImports: Map<string, Set<string>>; // package -> imported items
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
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped);
}

function extractPackageName(moduleSpecifier: string): string {
  // Handle scoped packages
  if (moduleSpecifier.startsWith('@')) {
    return moduleSpecifier.split('/').slice(0, 2).join('/');
  }
  // Handle regular packages
  return moduleSpecifier.split('/')[0];
}

function isNodeModule(moduleSpecifier: string, context: ImportAnalysisContext): boolean {
  const packageName = extractPackageName(moduleSpecifier);
  return !!(
    context.packageJson.dependencies?.[packageName] ||
    context.packageJson.devDependencies?.[packageName] ||
    context.packageJson.peerDependencies?.[packageName]
  );
}

function findPackageJson(tree: Tree, startPath: string): PackageJson | null {
  // 먼저 프로젝트 디렉토리에서 package.json을 찾습니다
  const projectPackageJsonPath = path.join(startPath, 'package.json');
  if (tree.exists(projectPackageJsonPath)) {
    return readJsonFromTree(tree, projectPackageJsonPath);
  }

  // 프로젝트 디렉토리에 없다면 루트 디렉토리의 package.json을 찾습니다
  const rootPackageJsonPath = '/package.json';
  if (tree.exists(rootPackageJsonPath)) {
    return readJsonFromTree(tree, rootPackageJsonPath);
  }

  return null;
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

  const projectRoot = project.root;
  const packageJson = findPackageJson(tree, projectRoot);

  if (!packageJson) {
    throw new Error('No package.json found in project or root directory');
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

  const internalPatterns = (options.internalModulePatterns || []).map(createRegexPattern);

  const analysisContext: ImportAnalysisContext = {
    paths,
    internalPatterns,
    packageJson,
    aliasPatterns: options.aliasPatterns
  };

  const tsProject = new Project({
    tsConfigFilePath: tsConfigPath,
    skipAddingFilesFromTsConfig: true
  })

  const srcDir = path.join(project.root, 'src')
  console.log('Source directory:', srcDir)
  tsProject.addSourceFilesAtPaths(path.join(srcDir, '**/*.{ts,tsx}'))

  const sourceFiles = tsProject.getSourceFiles()
  console.log('Source files:', sourceFiles.map(f => f.getFilePath()))

  const analysis: DependencyAnalysis = {
    externalImports: new Map<string, Set<string>>(),
    internalImports: new Set<string>(),
    internalAliasImports: new Set<string>()
  };

  sourceFiles.forEach(sourceFile => {
    const fileDir = path.dirname(sourceFile.getFilePath());

    // Analyze import declarations
    const importDeclarations = sourceFile.getImportDeclarations();
    importDeclarations.forEach(importDecl => {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      analyzeImport(moduleSpecifier, analysis, fileDir, analysisContext, importDecl);
    });

    // Analyze require calls
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
    name: packageJson.name,
    version: packageJson.version,
    dependencies: {},
    devDependencies: {},
    peerDependencies: packageJson.peerDependencies || {},
  };

  // Add only used dependencies
  analysis.externalImports.forEach((imports, packageName) => {
    if (packageJson.dependencies?.[packageName]) {
      optimizedPackageJson.dependencies[packageName] =
        packageJson.dependencies[packageName];
    } else if (packageJson.devDependencies?.[packageName]) {
      optimizedPackageJson.devDependencies[packageName] =
        packageJson.devDependencies[packageName];
    }
  });

  const outputPath = path.join(project.root, options.outputPath);
  writeJsonToTree(tree, outputPath, {
    ...optimizedPackageJson,
    internalDependencies: {
      relative: Array.from(analysis.internalImports),
      alias: Array.from(analysis.internalAliasImports)
    },
    usedImports: Object.fromEntries(
      Array.from(analysis.externalImports.entries()).map(([pkg, imports]) => [
        pkg,
        Array.from(imports)
      ])
    )
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

  return context.internalPatterns.some(pattern => pattern.test(moduleSpecifier));
}

function analyzeImport(
  moduleSpecifier: string,
  analysis: DependencyAnalysis,
  baseDir: string,
  context: ImportAnalysisContext,
  importDecl?: any
) {
  if (moduleSpecifier.startsWith('.') || moduleSpecifier.startsWith('/')) {
    const absolutePath = path.resolve(baseDir, moduleSpecifier);
    analysis.internalImports.add(absolutePath);
  } else if (isInternalAlias(moduleSpecifier, context)) {
    analysis.internalAliasImports.add(moduleSpecifier);
  } else if (isNodeModule(moduleSpecifier, context)) {
    const packageName = extractPackageName(moduleSpecifier);
    if (!analysis.externalImports.has(packageName)) {
      analysis.externalImports.set(packageName, new Set());
    }

    // Track imported items
    if (importDecl) {
      const namedImports = importDecl.getNamedImports();
      namedImports.forEach((namedImport: any) => {
        const name = namedImport.getName();
        analysis.externalImports.get(packageName)?.add(name);
      });

      const defaultImport = importDecl.getDefaultImport();
      if (defaultImport) {
        analysis.externalImports.get(packageName)?.add('default');
      }
    }
  }
}

export default analyzeDepsGenerator;
