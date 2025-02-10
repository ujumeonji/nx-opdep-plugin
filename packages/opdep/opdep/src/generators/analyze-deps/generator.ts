import { Tree, formatFiles, getProjects } from '@nx/devkit';
import { AnalyzeDepsGeneratorSchema } from './schema';
import { Project, SyntaxKind, ts } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';

interface PackageJson {
  name: string;
  version: string;
  dependencies?: { [key: string]: string };
  devDependencies?: { [key: string]: string };
  peerDependencies?: { [key: string]: string };
}

export async function analyzeDepsGenerator(
  tree: Tree,
  options: AnalyzeDepsGeneratorSchema
) {
  // Get the project configuration
  const projects = getProjects(tree);
  const project = projects.get(options.projectName);
  
  if (!project) {
    throw new Error(`Project ${options.projectName} not found`);
  }

  // Initialize ts-morph project
  const tsProject = new Project({
    tsConfigFilePath: path.join(project.root, 'tsconfig.json'),
  });

  // Get all source files
  const sourceFiles = tsProject.getSourceFiles();
  
  // Track all imports
  const imports = new Set<string>();

  // Analyze each source file
  sourceFiles.forEach(sourceFile => {
    // Get all import declarations
    const importDeclarations = sourceFile.getImportDeclarations();
    
    importDeclarations.forEach(importDecl => {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      
      // Only consider external packages (not relative imports)
      if (!moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/')) {
        // Handle scoped packages and submodules
        const packageName = moduleSpecifier.startsWith('@') 
          ? moduleSpecifier.split('/').slice(0, 2).join('/')
          : moduleSpecifier.split('/')[0];
        
        imports.add(packageName);
      }
    });

    // Also check for require statements
    const requireCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(call => {
        const expression = call.getExpression();
        return expression.getText() === 'require';
      });

    requireCalls.forEach(call => {
      const args = call.getArguments();
      if (args.length > 0) {
        const moduleSpecifier = args[0].getText().replace(/['"]/g, '');
        if (!moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/')) {
          const packageName = moduleSpecifier.startsWith('@')
            ? moduleSpecifier.split('/').slice(0, 2).join('/')
            : moduleSpecifier.split('/')[0];
          
          imports.add(packageName);
        }
      }
    });
  });

  // Read the original package.json
  const packageJsonPath = path.join(project.root, 'package.json');
  const originalPackageJson: PackageJson = JSON.parse(
    fs.readFileSync(packageJsonPath, 'utf-8')
  );

  // Create optimized package.json
  const optimizedPackageJson: PackageJson = {
    name: originalPackageJson.name,
    version: originalPackageJson.version,
    dependencies: {},
    devDependencies: {},
    peerDependencies: originalPackageJson.peerDependencies || {},
  };

  // Add only the dependencies that are actually used
  imports.forEach(packageName => {
    if (originalPackageJson.dependencies?.[packageName]) {
      optimizedPackageJson.dependencies[packageName] =
        originalPackageJson.dependencies[packageName];
    } else if (originalPackageJson.devDependencies?.[packageName]) {
      optimizedPackageJson.devDependencies[packageName] =
        originalPackageJson.devDependencies[packageName];
    }
  });

  // Write the optimized package.json
  const outputPath = path.join(project.root, options.outputPath);
  tree.write(
    outputPath,
    JSON.stringify(optimizedPackageJson, null, 2)
  );

  await formatFiles(tree);
}

export default analyzeDepsGenerator;
