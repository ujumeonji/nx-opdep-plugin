import { Tree, formatFiles, getProjects, logger } from '@nx/devkit';
import { AnalyzeDepsGeneratorSchema } from './schema';
import { Project, ImportDeclaration } from 'ts-morph';
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

interface WorkspaceLibrary {
  name: string;
  root: string;
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

const dependencyCache = new Map<string, PackageJson>();

function analyzeProjectDependencies(tree: Tree, projectRoot: string): PackageJson {
  if (dependencyCache.has(projectRoot)) {
    return dependencyCache.get(projectRoot)!;
  }
  const packageJson = findPackageJson(tree, projectRoot);
  if (!packageJson) {
    throw new Error(`No package.json found for project at ${projectRoot}`);
  }
  dependencyCache.set(projectRoot, packageJson);
  return packageJson;
}

const MAX_RECURSION_DEPTH = 50;

function getWorkspaceLibraries(tree: Tree): Map<string, WorkspaceLibrary> {
  const libraries = new Map<string, WorkspaceLibrary>();
  const projects = getProjects(tree);

  for (const [name, config] of projects.entries()) {
    if (config.projectType === 'library') {
      libraries.set(name, {
        name,
        root: config.root
      });
    }
  }

  return libraries;
}

function findTsConfigFiles(tree: Tree, libRoot: string): string[] {
  const workspaceRoot = tree.root;
  const configFiles = [];

  const baseTsConfigPath = path.join(workspaceRoot, 'tsconfig.base.json');
  if (tree.exists(baseTsConfigPath)) {
    configFiles.push(baseTsConfigPath);
  }

  const libTsConfigPath = path.join(libRoot, 'tsconfig.json');
  if (tree.exists(libTsConfigPath)) {
    configFiles.push(libTsConfigPath);
  }

  const libSpecificTsConfigPath = path.join(libRoot, 'tsconfig.lib.json');
  if (tree.exists(libSpecificTsConfigPath)) {
    configFiles.push(libSpecificTsConfigPath);
  }

  return configFiles;
}

function mergeTsConfigs(tree: Tree, configFiles: string[]): any {
  let mergedConfig: any = {};

  for (const configFile of configFiles) {
    try {
      const config = readJsonFromTree(tree, configFile);

      if (config.extends) {
        const extendsPath = path.resolve(path.dirname(configFile), config.extends);
        if (tree.exists(extendsPath)) {
          const baseConfig = readJsonFromTree(tree, extendsPath);
          mergedConfig = deepMerge(mergedConfig, baseConfig);
        }
      }

      mergedConfig = deepMerge(mergedConfig, config);
    } catch (error) {
      logger.warn(`Failed to parse TypeScript config at ${configFile}: ${error}`);
    }
  }

  return mergedConfig;
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };

  for (const key in source) {
    if (source[key] instanceof Object && key in target) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

function analyzeImport(
  moduleSpecifier: string,
  analysis: DependencyAnalysis,
  baseDir: string,
  context: {
    packageJson: any;
    tsConfig: any;
    workspaceLibs: Map<string, WorkspaceLibrary>;
    tree: Tree;
  },
  importDecl?: ImportDeclaration,
  analyzedPaths: Set<string> = new Set(),
  depth: number = 0
) {
  if (depth > MAX_RECURSION_DEPTH) {
    logger.warn(`Max recursion depth (${MAX_RECURSION_DEPTH}) exceeded: ${moduleSpecifier}`);
    return;
  }

  const fullPath = path.resolve(baseDir, moduleSpecifier);
  if (analyzedPaths.has(fullPath)) {
    return;
  }
  analyzedPaths.add(fullPath);

  if (moduleSpecifier.startsWith('.')) {
    const absolutePath = path.resolve(baseDir, moduleSpecifier);
    if (!analyzedPaths.has(absolutePath)) {
      analyzedPaths.add(absolutePath);
      analysis.internalImports.add(moduleSpecifier);
      const project = importDecl?.getSourceFile().getProject();
      let sourceFile = project?.getSourceFile(absolutePath + '.ts');
      if (!sourceFile) {
        sourceFile = project?.getSourceFile(absolutePath + '.tsx');
      }
      if (sourceFile) {
        if (depth > 0) {
          logger.info(`Recursively exploring file: ${sourceFile.getFilePath()}`);
        }
        const newBaseDir = path.dirname(sourceFile.getFilePath());
        const imports = sourceFile.getImportDeclarations();
        for (const subImport of imports) {
          const subModuleSpecifier = subImport.getModuleSpecifierValue();
          analyzeImport(subModuleSpecifier, analysis, newBaseDir, context, subImport, analyzedPaths, depth + 1);
        }

        const exports = sourceFile.getExportDeclarations();
        for (const exportDecl of exports) {
          const exportModuleSpecifier = exportDecl.getModuleSpecifierValue();
          if (exportModuleSpecifier) {
            analyzeImport(
              exportModuleSpecifier,
              analysis,
              newBaseDir,
              context,
              exportDecl as any,
              analyzedPaths,
              depth + 1
            );
          }
        }

        const exportStars = sourceFile.getExportDeclarations().filter(exp =>
          exp.isNamespaceExport() && exp.getModuleSpecifierValue()
        );
        for (const exportStar of exportStars) {
          const starModuleSpecifier = exportStar.getModuleSpecifierValue();
          if (starModuleSpecifier) {
            analyzeImport(
              starModuleSpecifier,
              analysis,
              newBaseDir,
              context,
              exportStar as any,
              analyzedPaths,
              depth + 1
            );
          }
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

      const aliasPath = paths[matchingAlias][0].replace('/*', '');
      const relativePath = moduleSpecifier.replace(matchingAlias.replace('/*', ''), '');
      const fullPath = path.join(aliasPath, relativePath);

      const project = importDecl?.getSourceFile().getProject();
      let sourceFile = project?.getSourceFile(fullPath + '.ts');
      if (!sourceFile) {
        sourceFile = project?.getSourceFile(fullPath + '.tsx');
      }

      if (sourceFile) {
        if (depth > 0) {
          logger.info(`Recursively exploring file: ${sourceFile.getFilePath()}`);
        }
        const newBaseDir = path.dirname(sourceFile.getFilePath());
        const imports = sourceFile.getImportDeclarations();

        for (const subImport of imports) {
          const subModuleSpecifier = subImport.getModuleSpecifierValue();
          analyzeImport(
            subModuleSpecifier,
            analysis,
            newBaseDir,
            context,
            subImport,
            analyzedPaths,
            depth + 1
          );
        }

        const exports = sourceFile.getExportDeclarations();
        for (const exportDecl of exports) {
          const exportModuleSpecifier = exportDecl.getModuleSpecifierValue();
          if (exportModuleSpecifier) {
            analyzeImport(
              exportModuleSpecifier,
              analysis,
              newBaseDir,
              context,
              exportDecl as any,
              analyzedPaths,
              depth + 1
            );
          }
        }

        const exportStars = sourceFile.getExportDeclarations().filter(exp =>
          exp.isNamespaceExport() && exp.getModuleSpecifierValue()
        );
        for (const exportStar of exportStars) {
          const starModuleSpecifier = exportStar.getModuleSpecifierValue();
          if (starModuleSpecifier) {
            analyzeImport(
              starModuleSpecifier,
              analysis,
              newBaseDir,
              context,
              exportStar as any,
              analyzedPaths,
              depth + 1
            );
          }
        }
      }
    } else {
      const workspaceLib = Array.from(context.workspaceLibs.values()).find(lib =>
        moduleSpecifier.startsWith(`@${lib.name}/`) || moduleSpecifier === `@${lib.name}`
      );

      if (workspaceLib) {
        analysis.internalImports.add(moduleSpecifier);

        try {
          const tsConfigFiles = findTsConfigFiles(context.tree, workspaceLib.root);
          const mergedTsConfig = mergeTsConfigs(context.tree, tsConfigFiles);

          const libProject = new Project({
            compilerOptions: mergedTsConfig.compilerOptions,
            skipAddingFilesFromTsConfig: true
          });

          const libSourceFiles = libProject.addSourceFilesAtPaths([
            path.join(workspaceLib.root, '**/*.ts'),
            path.join(workspaceLib.root, '**/*.tsx'),
            `!${path.join(workspaceLib.root, 'node_modules/**/*')}`,
            `!${path.join(workspaceLib.root, 'dist/**/*')}`,
            `!${path.join(workspaceLib.root, 'build/**/*')}`,
            `!${path.join(workspaceLib.root, '**/*.spec.ts')}`,
            `!${path.join(workspaceLib.root, '**/*.test.ts')}`,
            `!${path.join(workspaceLib.root, '**/*.spec.tsx')}`,
            `!${path.join(workspaceLib.root, '**/*.test.tsx')}`,
          ]);

          for (const sourceFile of libSourceFiles) {
            const libBaseDir = path.dirname(sourceFile.getFilePath());
            logger.info(`Recursively exploring workspace library file: ${sourceFile.getFilePath()}`);
            const imports = sourceFile.getImportDeclarations();
            for (const subImport of imports) {
              const subModuleSpecifier = subImport.getModuleSpecifierValue();
              analyzeImport(
                subModuleSpecifier,
                analysis,
                libBaseDir,
                context,
                subImport,
                analyzedPaths,
                depth + 1
              );
            }

            const exports = sourceFile.getExportDeclarations();
            for (const exportDecl of exports) {
              const exportModuleSpecifier = exportDecl.getModuleSpecifierValue();
              if (exportModuleSpecifier) {
                analyzeImport(
                  exportModuleSpecifier,
                  analysis,
                  libBaseDir,
                  context,
                  exportDecl as any,
                  analyzedPaths,
                  depth + 1
                );
              }
            }
          }
        } catch (error) {
          logger.warn(`Failed to analyze workspace library ${workspaceLib.name}: ${error}`);
        }
      } else {
        const isWorkspaceLib = Array.from(context.workspaceLibs.values()).some(lib =>
          moduleSpecifier.startsWith(`@${lib.name}/`) || moduleSpecifier === `@${lib.name}`
        );

        if (isWorkspaceLib) {
          analysis.internalImports.add(moduleSpecifier);
        } else {
          const imports = importDecl ? importDecl.getNamedImports().map(named => named.getName()) : [];
          if (!analysis.externalImports.has(moduleSpecifier)) {
            analysis.externalImports.set(moduleSpecifier, new Set());
          }
          imports.forEach(imp => analysis.externalImports.get(moduleSpecifier)?.add(imp));
        }
      }
    }
  } else {
    const names = importDecl ? importDecl.getNamedImports().map(named => named.getName()) : [];
    if (!analysis.externalImports.has(moduleSpecifier)) {
      analysis.externalImports.set(moduleSpecifier, new Set());
    }
    names.forEach(name => analysis.externalImports.get(moduleSpecifier)?.add(name));
  }
}

export async function analyzeDepsGenerator(tree: Tree, options: AnalyzeDepsGeneratorSchema) {
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

  const projectSourceFiles = tsProject.addSourceFilesAtPaths([
    path.join(project.root, '**/*.ts'),
    path.join(project.root, '**/*.tsx'),
    `!${path.join(project.root, 'node_modules/**/*')}`,
    `!${path.join(project.root, 'dist/**/*')}`,
    `!${path.join(project.root, 'build/**/*')}`,
    `!${path.join(project.root, '**/*.spec.ts')}`,
    `!${path.join(project.root, '**/*.test.ts')}`,
    `!${path.join(project.root, '**/*.spec.tsx')}`,
    `!${path.join(project.root, '**/*.test.tsx')}`,
  ]);

  logger.info(`Project analysis started: ${options.projectName}`);
  const analysis: DependencyAnalysis = {
    externalImports: new Map(),
    internalImports: new Set(),
    internalAliasImports: new Set()
  };

  const workspaceLibs = getWorkspaceLibraries(tree);

  for (const sourceFile of projectSourceFiles) {
    const baseDir = path.dirname(sourceFile.getFilePath());
    const imports = sourceFile.getImportDeclarations();
    for (const importDecl of imports) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      analyzeImport(
        moduleSpecifier,
        analysis,
        baseDir,
        { packageJson, tsConfig, workspaceLibs, tree },
        importDecl
      );
    }

    const exports = sourceFile.getExportDeclarations();
    for (const exportDecl of exports) {
      const moduleSpecifier = exportDecl.getModuleSpecifierValue();
      if (moduleSpecifier) {
        analyzeImport(
          moduleSpecifier,
          analysis,
          baseDir,
          { packageJson, tsConfig, workspaceLibs, tree },
          exportDecl as any
        );
      }
    }
  }

  const usedDependencies: { [key: string]: string } = {};
  const usedDevDependencies: { [key: string]: string } = {};

  for (const [moduleName] of analysis.externalImports) {
    if (packageJson.dependencies && packageJson.dependencies[moduleName]) {
      usedDependencies[moduleName] = packageJson.dependencies[moduleName];
    } else if (packageJson.devDependencies && packageJson.devDependencies[moduleName]) {
      usedDevDependencies[moduleName] = packageJson.devDependencies[moduleName];
    }
  }

  const outputPath = path.join(project.root, 'opdep.json');
  const output = {
    dependencies: usedDependencies,
    devDependencies: usedDevDependencies,
    analysis: {
      externalImports: Object.fromEntries(
        Array.from(analysis.externalImports.entries()).map(([key, value]) => [
          key,
          Array.from(value)
        ])
      ),
      internalImports: Array.from(analysis.internalImports),
      internalAliasImports: Array.from(analysis.internalAliasImports)
    }
  };

  writeJsonToTree(tree, outputPath, output);
  await formatFiles(tree);

  logger.info(`Analysis complete for ${options.projectName}`);
  logger.info(`Found ${Object.keys(usedDependencies).length} used dependencies`);
  logger.info(`Found ${Object.keys(usedDevDependencies).length} used dev dependencies`);
}

export default analyzeDepsGenerator;
