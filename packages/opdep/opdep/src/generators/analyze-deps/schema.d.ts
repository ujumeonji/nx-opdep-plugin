export interface AnalyzeDepsGeneratorSchema {
  projectName: string;
  outputPath: string;
  internalModulePatterns?: string[];  // 내부 모듈을 식별하기 위한 정규식 패턴 배열
}
