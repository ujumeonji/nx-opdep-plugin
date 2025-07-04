export interface AnalyzeDepsGeneratorSchema {
  projectName: string;
  outputPath: string;
  targetLibs?: string[];
  internalModulePatterns?: string[];
  aliasPatterns?: string[];
  optimizePackageJson?: boolean;
  replaceOriginal?: boolean;
}
