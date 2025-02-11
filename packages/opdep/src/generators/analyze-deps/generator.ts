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
  externalImports: Map<string, Set<string>>;
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
  if (moduleSpecifier.startsWith('@')) {
    return moduleSpecifier.split('/').slice(0, 2).join('/');
  }
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
  const projectPackageJsonPath = path.join(startPath, 'package.json');
  if (tree.exists(projectPackageJsonPath)) {
    return readJsonFromTree(tree, projectPackageJsonPath);
  }

  const rootPackageJsonPath = '/package.json';
  if (tree.exists(rootPackageJsonPath)) {
    return readJsonFromTree(tree, rootPackageJsonPath);
  }

  return null;
}

function analyzeProjectDependencies(
  tree: Tree,
  projectRoot: string,
  analyzedProjects: Set<string> = new Set()
): PackageJson {
  const packageJson = findPackageJson(tree, projectRoot);
  if (!packageJson) {
    throw new Error(`No package.json found for project at ${projectRoot}`);
  }

  if (analyzedProjects.has(projectRoot)) {
    return packageJson;
  }
  analyzedProjects.add(projectRoot);

  const allDependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
  };

  const projects = getProjects(tree);
  for (const [, project] of projects) {
    if (project.root !== projectRoot && allDependencies[project.name]) {
      const subPackageJson = analyzeProjectDependencies(tree, project.root, analyzedProjects);
      packageJson.dependencies = {
        ...packageJson.dependencies,
        ...subPackageJson.dependencies,
      };
      packageJson.devDependencies = {
        ...packageJson.devDependencies,
        ...subPackageJson.devDependencies,
      };
      if (subPackageJson.peerDependencies) {
        packageJson.peerDependencies = {
          ...packageJson.peerDependencies,
          ...subPackageJson.peerDependencies,
        };
      }
    }
  }

  return packageJson;
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
  const packageJson = analyzeProjectDependencies(tree, projectRoot);

  const tsConfigPath = path.join(project.root, 'tsconfig.json');
  const tsConfig = readJsonFromTree(tree, tsConfigPath);

  const tsProject = new Project({
    tsConfigFilePath: tsConfigPath,
  });

  const sourceFiles = tsProject.getSourceFiles();
  const analysis: DependencyAnalysis = {
    externalImports: new Map(),
    internalImports: new Set(),
    internalAliasImports: new Set(),
  };

  const context: ImportAnalysisContext = {
    paths: tsConfig.compilerOptions?.paths || {},
    internalPatterns: [createRegexPattern(project.root)],
    packageJson,
  };

  for (const sourceFile of sourceFiles) {
    const imports = sourceFile.getImportDeclarations();
    for (const importDecl of imports) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      analyzeImport(moduleSpecifier, analysis, project.root, context, importDecl);
    }
  }

  const outputPath = path.join(project.root, 'opdep.json');
  const output = {
    externalImports: Object.fromEntries(
      Array.from(analysis.externalImports.entries()).map(([key, value]) => [
        key,
        Array.from(value),
      ])
    ),
    internalImports: Array.from(analysis.internalImports),
    internalAliasImports: Array.from(analysis.internalAliasImports),
  };

  writeJsonToTree(tree, outputPath, output);

  await formatFiles(tree);
}

function isInternalAlias(moduleSpecifier: string, context: ImportAnalysisContext): boolean {
  if (!context.paths) return false;

  for (const [alias, paths] of Object.entries(context.paths)) {
    const pattern = alias.replace(/\*/, '(.*)');
    const regex = new RegExp(`^${pattern}$`);
    if (regex.test(moduleSpecifier)) {
      return true;
    }
  }
  return false;
}

function analyzeImport(
  moduleSpecifier: string,
  analysis: DependencyAnalysis,
  baseDir: string,
  context: ImportAnalysisContext,
  importDecl?: any
) {
  if (isNodeModule(moduleSpecifier, context)) {
    const packageName = extractPackageName(moduleSpecifier);
    if (!analysis.externalImports.has(packageName)) {
      analysis.externalImports.set(packageName, new Set());
    }
    const imports = analysis.externalImports.get(packageName)!;
    const namedImports = importDecl?.getNamedImports();
    if (namedImports?.length > 0) {
      namedImports.forEach((namedImport: any) => {
        imports.add(namedImport.getName());
      });
    }
  } else if (isInternalAlias(moduleSpecifier, context)) {
    analysis.internalAliasImports.add(moduleSpecifier);
  } else {
    analysis.internalImports.add(moduleSpecifier);
  }
}

export default analyzeDepsGenerator;
