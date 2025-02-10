import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, readProjectConfiguration } from '@nx/devkit';

import { analyzeDepsGenerator } from './generator';
import { AnalyzeDepsGeneratorSchema } from './schema';

describe('analyze-deps generator', () => {
  let tree: Tree;
  const options: AnalyzeDepsGeneratorSchema = { name: 'test' };

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('should run successfully', async () => {
    await analyzeDepsGenerator(tree, options);
    const config = readProjectConfiguration(tree, 'test');
    expect(config).toBeDefined();
  });
});
