import { Tree, formatFiles, getProjects } from '@nx/devkit';
import { AnalyzeDepsGeneratorSchema } from './schema';
import { Project, SyntaxKind, ts, Node, ImportDeclaration } from 'ts-morph';
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
    skipAddingFilesFromTsConfig: true
  });

  const srcDir = path.join(project.root, 'src');
  const projectSourceFiles = tsProject.addSourceFilesAtPaths(path.join(srcDir, '**/*.{ts,tsx}'));

  console.log(`Analyzing project: ${options.projectName}`);
  console.log('Source files found:', projectSourceFiles.map(f => f.getFilePath()));

  const analysis: DependencyAnalysis = {
    externalImports: new Map(),
    internalImports: new Set(),
    internalAliasImports: new Set()
  };

  for (const sourceFile of projectSourceFiles) {
    const imports = sourceFile.getImportDeclarations();
    const baseDir = path.dirname(sourceFile.getFilePath());

    for (const importDecl of imports) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      analyzeImport(moduleSpecifier, analysis, baseDir, { packageJson, tsConfig }, importDecl);
    }
  }

  const outputPath = path.join(project.root, 'opdep.json');
  const output = {
    dependencies: packageJson.dependencies || {},
    devDependencies: packageJson.devDependencies || {}
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
  context: { packageJson: any; tsConfig: any },
  importDecl?: ImportDeclaration,
  analyzedPaths: Set<string> = new Set()
) {
  if (moduleSpecifier.startsWith('.')) {
    const absolutePath = path.resolve(baseDir, moduleSpecifier);
    if (!analyzedPaths.has(absolutePath)) {
      analyzedPaths.add(absolutePath);
      analysis.internalImports.add(moduleSpecifier);

      const sourceFile = importDecl?.getSourceFile().getProject().getSourceFile(absolutePath + '.ts') ||
                        importDecl?.getSourceFile().getProject().getSourceFile(absolutePath + '.tsx');
      
      if (sourceFile) {
        const imports = sourceFile.getImportDeclarations();
        const newBaseDir = path.dirname(sourceFile.getFilePath());
        
        for (const subImport of imports) {
          const subModuleSpecifier = subImport.getModuleSpecifierValue();
          analyzeImport(subModuleSpecifier, analysis, newBaseDir, context, subImport, analyzedPaths);
        }
      }
    }
  } else if (moduleSpecifier.startsWith('@')) {
    const paths = context.tsConfig.compilerOptions?.paths || {};
    const matchingAlias = Object.keys(paths).find(alias => 
      moduleSpecifier.startsWith(alias.replace('/*', ''))
    );

    if (matchingAlias) {
      analysis.internalAliasImports.add(moduleSpecifier);
    } else {
      const imports = importDecl ? 
        importDecl.getNamedImports().map(named => named.getName()) : 
        [];
      
      if (!analysis.externalImports.has(moduleSpecifier)) {
        analysis.externalImports.set(moduleSpecifier, new Set());
      }
      imports.forEach(imp => analysis.externalImports.get(moduleSpecifier)?.add(imp));
    }
  } else {
    const imports = importDecl ? 
      importDecl.getNamedImports().map(named => named.getName()) : 
      [];
    
    if (!analysis.externalImports.has(moduleSpecifier)) {
      analysis.externalImports.set(moduleSpecifier, new Set());
    }
    imports.forEach(imp => analysis.externalImports.get(moduleSpecifier)?.add(imp));
  }
}

export default analyzeDepsGenerator;
