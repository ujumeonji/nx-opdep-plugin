import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree } from '@nx/devkit';
import * as path from 'path';
import { analyzeDepsGenerator } from './generator';
import { AnalyzeDepsGeneratorSchema } from './schema';

describe('analyze-deps generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('should analyze dependencies correctly', async () => {
    const projectName = 'test-project';
    const projectRoot = `apps/${projectName}`;

    tree.write(
      path.join(projectRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'es5',
          module: 'commonjs',
          strict: true,
        }
      })
    );

    tree.write(
      path.join(projectRoot, 'src/index.ts'),
      `
        import { useState } from 'react';
        import { map } from 'lodash';
        import { something } from './local-file';
        const axios = require('axios');
      `
    );

    const originalPackageJson = {
      name: 'test-project',
      version: '1.0.0',
      dependencies: {
        react: '^17.0.0',
        lodash: '^4.17.0',
        axios: '^0.21.0',
        'unused-dep': '^1.0.0'
      },
      devDependencies: {
        typescript: '^4.0.0',
        'unused-dev-dep': '^1.0.0'
      }
    };

    tree.write(
      path.join(projectRoot, 'package.json'),
      JSON.stringify(originalPackageJson, null, 2)
    );

    const options: AnalyzeDepsGeneratorSchema = {
      projectName,
      outputPath: 'optimized-package.json'
    };

    await analyzeDepsGenerator(tree, options);

    const optimizedContent = tree.read(path.join(projectRoot, 'optimized-package.json'));

    if (!optimizedContent) {
      throw new Error('Failed to read optimized-package.json');
    }

    const optimizedPackageJson = JSON.parse(optimizedContent.toString());

    expect(optimizedPackageJson.dependencies).toEqual({
      react: '^17.0.0',
      lodash: '^4.17.0',
      axios: '^0.21.0'
    });

    expect(optimizedPackageJson.dependencies['unused-dep']).toBeUndefined();
    expect(optimizedPackageJson.devDependencies['unused-dev-dep']).toBeUndefined();

    expect(optimizedPackageJson.name).toBe('test-project');
    expect(optimizedPackageJson.version).toBe('1.0.0');
  });

  it('should handle scoped packages correctly', async () => {
    const projectName = 'scoped-test';
    const projectRoot = `apps/${projectName}`;

    tree.write(
      path.join(projectRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'es5',
          module: 'commonjs',
          strict: true,
        }
      })
    );

    tree.write(
      path.join(projectRoot, 'src/index.ts'),
      `
        import { something } from '@scope/package';
        import { other } from '@scope/package/submodule';
      `
    );

    const originalPackageJson = {
      name: 'scoped-test',
      version: '1.0.0',
      dependencies: {
        '@scope/package': '^1.0.0',
        '@other/unused': '^1.0.0'
      }
    };

    tree.write(
      path.join(projectRoot, 'package.json'),
      JSON.stringify(originalPackageJson, null, 2)
    );

    const options: AnalyzeDepsGeneratorSchema = {
      projectName,
      outputPath: 'optimized-package.json'
    };

    await analyzeDepsGenerator(tree, options);

    const optimizedContent = tree.read(path.join(projectRoot, 'optimized-package.json'));

    if (!optimizedContent) {
      throw new Error('Failed to read optimized-package.json');
    }

    const optimizedPackageJson = JSON.parse(optimizedContent.toString());

    expect(optimizedPackageJson.dependencies).toEqual({
      '@scope/package': '^1.0.0'
    });

    expect(optimizedPackageJson.dependencies['@other/unused']).toBeUndefined();
  });

  it('should throw error for non-existent project', async () => {
    const options: AnalyzeDepsGeneratorSchema = {
      projectName: 'non-existent',
      outputPath: 'optimized-package.json'
    };

    await expect(analyzeDepsGenerator(tree, options)).rejects.toThrow(
      'Project non-existent not found'
    );
  });

  it('should analyze direct dependencies', async () => {
    // Setup project structure
    tree.write(
      'package.json',
      JSON.stringify({
        dependencies: {
          '@nestjs/core': '^8.0.0',
          'unused-dep': '^1.0.0'
        },
        devDependencies: {
          '@types/node': '^16.0.0'
        }
      })
    )

    tree.write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          paths: {
            '@app/*': ['src/*']
          }
        }
      })
    )

    tree.write(
      'project.json',
      JSON.stringify({
        name: 'test-project',
        root: '.'
      })
    )

    tree.write(
      'src/main.ts',
      `
        import { NestFactory } from '@nestjs/core'
        import { AppModule } from './app.module'
      `
    )

    // Execute generator
    await analyzeDepsGenerator(tree, { projectName: 'test-project' })

    // Verify output
    const output = JSON.parse(tree.read('opdep.json', 'utf-8'))

    expect(output.dependencies).toHaveProperty('@nestjs/core')
    expect(output.dependencies).not.toHaveProperty('unused-dep')
    expect(output.analysis.externalImports).toHaveProperty('@nestjs/core')
  })

  it('should analyze transitive dependencies through aliases', async () => {
    // Setup project with alias imports
    tree.write(
      'package.json',
      JSON.stringify({
        dependencies: {
          '@nestjs/core': '^8.0.0',
          '@nestjs/common': '^8.0.0'
        }
      })
    )

    tree.write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          paths: {
            '@libs/*': ['libs/*']
          }
        }
      })
    )

    tree.write(
      'project.json',
      JSON.stringify({
        name: 'test-project',
        root: '.'
      })
    )

    // Main file imports from alias
    tree.write(
      'src/main.ts',
      `
        import { SomeService } from '@libs/shared'
      `
    )

    // Aliased file has external dependency
    tree.write(
      'libs/shared.ts',
      `
        import { Injectable } from '@nestjs/common'
        
        @Injectable()
        export class SomeService {}
      `
    )

    await analyzeDepsGenerator(tree, { projectName: 'test-project' })

    const output = JSON.parse(tree.read('opdep.json', 'utf-8'))

    expect(output.dependencies).toHaveProperty('@nestjs/common')
    expect(output.analysis.internalAliasImports).toContain('@libs/shared')
    expect(output.analysis.externalImports).toHaveProperty('@nestjs/common')
  })

  it('should handle circular dependencies gracefully', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        dependencies: {
          '@nestjs/core': '^8.0.0'
        }
      })
    )

    tree.write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          paths: {
            '@app/*': ['src/*']
          }
        }
      })
    )

    tree.write(
      'project.json',
      JSON.stringify({
        name: 'test-project',
        root: '.'
      })
    )

    // Create circular dependency
    tree.write(
      'src/a.ts',
      `
        import { b } from './b'
        export const a = 'a'
      `
    )

    tree.write(
      'src/b.ts',
      `
        import { a } from './a'
        export const b = 'b'
      `
    )

    await expect(
      analyzeDepsGenerator(tree, { projectName: 'test-project' })
    ).resolves.not.toThrow()
  })

  it('should handle missing files gracefully', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        dependencies: {}
      })
    )

    tree.write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {}
      })
    )

    tree.write(
      'project.json',
      JSON.stringify({
        name: 'test-project',
        root: '.'
      })
    )

    tree.write(
      'src/main.ts',
      `
        import { NonExistentModule } from './non-existent'
      `
    )

    await expect(
      analyzeDepsGenerator(tree, { projectName: 'test-project' })
    ).resolves.not.toThrow()
  })
});
