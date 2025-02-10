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
});
