import type { Tree } from "@nx/devkit";
import { formatFiles, getProjects, logger } from "@nx/devkit";
import type { AnalyzeDepsGeneratorSchema } from "./schema";
import { Project, type ImportDeclaration } from "ts-morph";
import * as path from "node:path";
import type { CompilerOptions } from "typescript";
import type { ProjectOptions } from "ts-morph";

/**
 * Interface representing a package.json file
 */
interface PackageJson {
	name: string;
	version: string;
	dependencies: { [key: string]: string };
	devDependencies: { [key: string]: string };
	peerDependencies?: { [key: string]: string };
}

/**
 * Interface representing the result of dependency analysis
 */
interface DependencyAnalysis {
	externalImports: Map<string, Set<string>>;
	internalImports: Set<string>;
	internalAliasImports: Set<string>;
}

/**
 * Interface representing a workspace library
 */
interface WorkspaceLibrary {
	name: string;
	root: string;
}

/**
 * Interface for used dependencies
 */
interface UsedDependencies {
	usedDependencies: { [key: string]: string };
	usedDevDependencies: { [key: string]: string };
}

/**
 * Class responsible for file system operations
 */
class FileSystemManager {
	private tree: Tree;

	/**
	 * Creates a new FileSystemManager
	 * @param tree The file system tree
	 */
	constructor(tree: Tree) {
		this.tree = tree;
	}

	/**
	 * Reads a JSON file from the tree
	 * @param filePath The path to the file
	 * @returns The parsed JSON content
	 */
	public readJsonFromTree<T = unknown>(filePath: string): T {
		const content = this.tree.read(filePath, "utf-8");
		if (!content) {
			throw new Error(`File not found: ${filePath}`);
		}
		return JSON.parse(content) as T;
	}

	/**
	 * Writes JSON content to a file in the tree
	 * @param filePath The path to the file
	 * @param content The content to write
	 */
	public writeJsonToTree(filePath: string, content: unknown): void {
		this.tree.write(filePath, JSON.stringify(content, null, 2));
	}

	/**
	 * Checks if a file exists in the tree
	 * @param filePath The path to the file
	 * @returns True if the file exists, false otherwise
	 */
	public fileExists(filePath: string): boolean {
		return this.tree.exists(filePath);
	}

	/**
	 * Gets the children of a directory
	 * @param dirPath The path to the directory
	 * @returns The children of the directory
	 */
	public getDirectoryChildren(dirPath: string): string[] {
		return this.tree.children(dirPath);
	}

	/**
	 * Checks if a path is a file
	 * @param path The path to check
	 * @returns True if the path is a file, false otherwise
	 */
	public isFile(path: string): boolean {
		return this.tree.isFile(path);
	}

	/**
	 * Gets the root of the tree
	 * @returns The root of the tree
	 */
	public getRoot(): string {
		return this.tree.root;
	}
}

/**
 * Class responsible for package.json operations
 */
class PackageJsonManager {
	private fileSystemManager: FileSystemManager;
	private dependencyCache = new Map<string, PackageJson>();

	/**
	 * Creates a new PackageJsonManager
	 * @param fileSystemManager The file system manager
	 */
	constructor(fileSystemManager: FileSystemManager) {
		this.fileSystemManager = fileSystemManager;
	}

	/**
	 * Finds a package.json file starting from a given path
	 * @param startPath The path to start searching from
	 * @returns The package.json content or null if not found
	 */
	public findPackageJson(startPath: string): PackageJson | null {
		const projectPackageJsonPath = path.join(startPath, "package.json");
		if (this.fileSystemManager.fileExists(projectPackageJsonPath)) {
			return this.fileSystemManager.readJsonFromTree<PackageJson>(projectPackageJsonPath);
		}
		const rootPackageJsonPath = "/package.json";
		if (this.fileSystemManager.fileExists(rootPackageJsonPath)) {
			return this.fileSystemManager.readJsonFromTree<PackageJson>(rootPackageJsonPath);
		}
		return null;
	}

	/**
	 * Analyzes project dependencies
	 * @param projectRoot The root of the project
	 * @returns The package.json content
	 */
	public analyzeProjectDependencies(projectRoot: string): PackageJson {
		if (this.dependencyCache.has(projectRoot)) {
			return this.dependencyCache.get(projectRoot) as PackageJson;
		}
		const packageJson = this.findPackageJson(projectRoot);
		if (!packageJson) {
			throw new Error(`No package.json found for project at ${projectRoot}`);
		}
		this.dependencyCache.set(projectRoot, packageJson);
		return packageJson;
	}
}

/**
 * Class responsible for TypeScript configuration operations
 */
class TypeScriptConfigManager {
	private fileSystemManager: FileSystemManager;

	/**
	 * Creates a new TypeScriptConfigManager
	 * @param fileSystemManager The file system manager
	 */
	constructor(fileSystemManager: FileSystemManager) {
		this.fileSystemManager = fileSystemManager;
	}

	/**
	 * Gets the root TypeScript configuration
	 * @returns The root TypeScript configuration
	 */
	public getRootTsConfig(): Record<string, unknown> {
		const rootTsConfigPath = "/tsconfig.base.json";
		if (!this.fileSystemManager.fileExists(rootTsConfigPath)) {
			logger.warn("No tsconfig.base.json found in workspace root");
			return { compilerOptions: { paths: {} } };
		}

		try {
			const config =
				this.fileSystemManager.readJsonFromTree<Record<string, unknown>>(rootTsConfigPath);
			const compilerOptions =
				(config as { compilerOptions?: Record<string, unknown> })
					.compilerOptions || {};
			return {
				...config,
				compilerOptions: {
					...compilerOptions,
					paths:
						(compilerOptions as { paths?: Record<string, unknown> }).paths ||
						{},
				},
			};
		} catch (error) {
			logger.warn(
				`Failed to parse TypeScript config at ${rootTsConfigPath}: ${error}`,
			);
			return { compilerOptions: { paths: {} } };
		}
	}

	/**
	 * Finds all TypeScript configuration files in a project
	 * @param projectRoot The root of the project
	 * @returns An array of TypeScript configuration file paths
	 */
	public findAllTsConfigFiles(projectRoot: string): string[] {
		const tsConfigFiles: Set<string> = new Set();
		const tsConfigPattern = /^tsconfig.*\.json$/;

		const searchInDirectory = (dirPath: string) => {
			const entries = this.fileSystemManager.getDirectoryChildren(dirPath);
			for (const entry of entries) {
				const fullPath = path.join(dirPath, entry);
				if (this.fileSystemManager.isFile(fullPath) && tsConfigPattern.test(entry)) {
					tsConfigFiles.add(fullPath);
				} else if (!this.fileSystemManager.isFile(fullPath)) {
					searchInDirectory(fullPath);
				}
			}
		};

		searchInDirectory(projectRoot);

		const workspaceRoot = this.fileSystemManager.getRoot();
		if (workspaceRoot !== projectRoot) {
			searchInDirectory(workspaceRoot);
		}

		return Array.from(tsConfigFiles);
	}
}

/**
 * Class responsible for analyzing dependencies in a project
 */
class DependencyAnalyzer {
	private MAX_RECURSION_DEPTH = 50;
	private tree: Tree;
	private workspaceLibs: Map<string, WorkspaceLibrary>;
	private tsConfig: Record<string, unknown>;
	private packageJson: PackageJson;
	private _analyzedPaths: Set<string> = new Set();
	private analysis: DependencyAnalysis = {
		externalImports: new Map(),
		internalImports: new Set(),
		internalAliasImports: new Set(),
	};
	private fileSystemManager: FileSystemManager;
	private tsConfigManager: TypeScriptConfigManager;
	private packageJsonManager: PackageJsonManager;

	/**
	 * Creates a new DependencyAnalyzer
	 * @param tree The file system tree
	 * @param tsConfig The TypeScript configuration
	 * @param packageJson The package.json content
	 * @param workspaceLibs The workspace libraries
	 */
	constructor(
		tree: Tree,
		tsConfig: Record<string, unknown>,
		packageJson: PackageJson,
		workspaceLibs: Map<string, WorkspaceLibrary>,
	) {
		this.tree = tree;
		this.tsConfig = tsConfig;
		this.packageJson = packageJson;
		this.workspaceLibs = workspaceLibs;
		this.fileSystemManager = new FileSystemManager(tree);
		this.tsConfigManager = new TypeScriptConfigManager(this.fileSystemManager);
		this.packageJsonManager = new PackageJsonManager(this.fileSystemManager);
	}

	/**
	 * Gets the analyzed paths
	 * @returns The set of analyzed paths
	 */
	public get analyzedPaths() {
		return this._analyzedPaths;
	}

	/**
	 * Analyzes an import statement
	 * @param moduleSpecifier The module specifier
	 * @param baseDir The base directory
	 * @param importDecl The import declaration
	 * @param depth The recursion depth
	 */
	private analyzeImport(
		moduleSpecifier: string,
		baseDir: string,
		importDecl?: ImportDeclaration,
		depth = 0,
	) {
		logger.info(`Analyzing import: ${moduleSpecifier}`);

		if (depth > this.MAX_RECURSION_DEPTH) {
			logger.warn(
				`Max recursion depth (${this.MAX_RECURSION_DEPTH}) exceeded: ${moduleSpecifier}`,
			);
			return;
		}

		const fullPath = path.resolve(baseDir, moduleSpecifier);
		if (this._analyzedPaths.has(fullPath)) {
			return;
		}
		this._analyzedPaths.add(fullPath);

		if (moduleSpecifier.startsWith(".")) {
			this.handleRelativeImport(moduleSpecifier, baseDir, importDecl, depth);
		} else if (moduleSpecifier.startsWith("@")) {
			this.handleAtPrefixedImport(moduleSpecifier, baseDir, importDecl, depth);
		} else {
			this.handleExternalImport(moduleSpecifier, importDecl);
		}
	}

	/**
	 * Handles a relative import (starting with ".")
	 * @param moduleSpecifier The module specifier
	 * @param baseDir The base directory
	 * @param importDecl The import declaration
	 * @param depth The recursion depth
	 */
	private handleRelativeImport(
		moduleSpecifier: string,
		baseDir: string,
		importDecl?: ImportDeclaration,
		depth = 0,
	) {
		const absolutePath = path.resolve(baseDir, moduleSpecifier);
		if (!this._analyzedPaths.has(absolutePath)) {
			this._analyzedPaths.add(absolutePath);
			this.analysis.internalImports.add(moduleSpecifier);
			const project = importDecl?.getSourceFile().getProject();
			let sourceFile = project?.getSourceFile(`${absolutePath}.ts`);
			if (!sourceFile) {
				sourceFile = project?.getSourceFile(`${absolutePath}.tsx`);
			}
			if (sourceFile) {
				this.processSourceFile(sourceFile, depth);
			}
		}
	}

	/**
	 * Handles an import starting with "@"
	 * @param moduleSpecifier The module specifier
	 * @param baseDir The base directory
	 * @param importDecl The import declaration
	 * @param depth The recursion depth
	 */
	private handleAtPrefixedImport(
		moduleSpecifier: string,
		baseDir: string,
		importDecl?: ImportDeclaration,
		depth = 0,
	) {
		const paths =
			(
				this.tsConfig as {
					compilerOptions?: { paths?: Record<string, string[]> };
				}
			).compilerOptions?.paths || {};
		const matchingAlias = Object.keys(paths).find((alias) =>
			moduleSpecifier.startsWith(alias.replace("/*", "")),
		);

		if (matchingAlias) {
			this.handleAliasImport(moduleSpecifier, matchingAlias, paths, importDecl, depth);
		} else {
			this.handleWorkspaceLibraryImport(moduleSpecifier, importDecl, depth);
		}
	}

	/**
	 * Handles an alias import (matching a path in tsconfig)
	 * @param moduleSpecifier The module specifier
	 * @param matchingAlias The matching alias from tsconfig
	 * @param paths The paths from tsconfig
	 * @param importDecl The import declaration
	 * @param depth The recursion depth
	 */
	private handleAliasImport(
		moduleSpecifier: string,
		matchingAlias: string,
		paths: Record<string, string[]>,
		importDecl?: ImportDeclaration,
		depth = 0,
	) {
		this.analysis.internalAliasImports.add(moduleSpecifier);

		const aliasRelative = paths[matchingAlias][0].replace("/*", "");
		const workspaceRoot = this.tree.root;
		const aliasPath = path.resolve(workspaceRoot, aliasRelative);
		const aliasPrefix = matchingAlias.replace("/*", "");
		const relativePath = moduleSpecifier.startsWith(aliasPrefix)
			? moduleSpecifier.slice(aliasPrefix.length)
			: "";
		const fullAliasPath = path.join(aliasPath, relativePath);
		logger.info(
			`Resolving alias import: ${moduleSpecifier} -> ${fullAliasPath}`,
		);

		const project = importDecl?.getSourceFile().getProject();
		const sourceFile = project?.getSourceFile(fullAliasPath);

		if (!sourceFile) {
			logger.info(
				`Could not find source file for alias import: ${moduleSpecifier}(${fullAliasPath})`,
			);
		}

		if (sourceFile) {
			this.processSourceFile(sourceFile, depth);
		}
	}

	/**
	 * Handles a workspace library import
	 * @param moduleSpecifier The module specifier
	 * @param importDecl The import declaration
	 * @param depth The recursion depth
	 */
	private handleWorkspaceLibraryImport(
		moduleSpecifier: string,
		importDecl?: ImportDeclaration,
		depth = 0,
	) {
		const workspaceLib = Array.from(this.workspaceLibs.values()).find(
			(lib) =>
				moduleSpecifier.startsWith(`@${lib.name}/`) ||
				moduleSpecifier === `@${lib.name}`,
		);

		if (workspaceLib) {
			this.analysis.internalImports.add(moduleSpecifier);

			try {
				const libProject = new Project({
					skipAddingFilesFromTsConfig: true,
				});

				const libSourceFiles = libProject.addSourceFilesAtPaths([
					path.join(workspaceLib.root, "**/*.ts"),
					path.join(workspaceLib.root, "**/*.tsx"),
					`!${path.join(workspaceLib.root, "node_modules/**/*")}`,
					`!${path.join(workspaceLib.root, "dist/**/*")}`,
					`!${path.join(workspaceLib.root, "build/**/*")}`,
					`!${path.join(workspaceLib.root, "**/*.spec.ts")}`,
					`!${path.join(workspaceLib.root, "**/*.test.ts")}`,
					`!${path.join(workspaceLib.root, "**/*.spec.tsx")}`,
					`!${path.join(workspaceLib.root, "**/*.test.tsx")}`,
				]);

				for (const sourceFile of libSourceFiles) {
					const libBaseDir = path.dirname(sourceFile.getFilePath());
					logger.info(
						`Recursively exploring workspace library file: ${sourceFile.getFilePath()}`,
					);
					this.processSourceFileWithCustomBaseDir(sourceFile, libBaseDir, depth);
				}
			} catch (error) {
				logger.warn(
					`Failed to analyze workspace library ${workspaceLib.name}: ${error}`,
				);
			}
		} else {
			this.handleNonWorkspaceAtPrefixedImport(moduleSpecifier, importDecl);
		}
	}

	/**
	 * Handles a non-workspace import starting with "@"
	 * @param moduleSpecifier The module specifier
	 * @param importDecl The import declaration
	 */
	private handleNonWorkspaceAtPrefixedImport(
		moduleSpecifier: string,
		importDecl?: ImportDeclaration,
	) {
		const isWorkspaceLib = Array.from(this.workspaceLibs.values()).some(
			(lib) =>
				moduleSpecifier.startsWith(`@${lib.name}/`) ||
				moduleSpecifier === `@${lib.name}`,
		);

		if (isWorkspaceLib) {
			this.analysis.internalImports.add(moduleSpecifier);
		} else {
			this.handleExternalImport(moduleSpecifier, importDecl);
		}
	}

	/**
	 * Handles an external import
	 * @param moduleSpecifier The module specifier
	 * @param importDecl The import declaration
	 */
	private handleExternalImport(
		moduleSpecifier: string,
		importDecl?: ImportDeclaration,
	) {
		const names = importDecl
			? importDecl.getNamedImports().map((named) => named.getName())
			: [];
		if (!this.analysis.externalImports.has(moduleSpecifier)) {
			this.analysis.externalImports.set(moduleSpecifier, new Set());
		}
		for (const name of names) {
			this.analysis.externalImports.get(moduleSpecifier)?.add(name);
		}
	}

	/**
	 * Processes a source file, analyzing its imports and exports
	 * @param sourceFile The source file to process
	 * @param depth The recursion depth
	 */
	private processSourceFile(sourceFile: import("ts-morph").SourceFile, depth = 0) {
		if (depth > 0) {
			logger.info(
				`Recursively exploring file: ${sourceFile.getFilePath()}`,
			);
		}
		const newBaseDir = path.dirname(sourceFile.getFilePath());
		this.processSourceFileWithCustomBaseDir(sourceFile, newBaseDir, depth);
	}

	/**
	 * Processes a source file with a custom base directory
	 * @param sourceFile The source file to process
	 * @param baseDir The base directory
	 * @param depth The recursion depth
	 */
	private processSourceFileWithCustomBaseDir(
		sourceFile: import("ts-morph").SourceFile,
		baseDir: string,
		depth = 0,
	) {
		// Process imports
		const imports = sourceFile.getImportDeclarations();
		for (const subImport of imports) {
			const subModuleSpecifier = subImport.getModuleSpecifierValue();
			this.analyzeImport(
				subModuleSpecifier,
				baseDir,
				subImport,
				depth + 1,
			);
		}

		// Process regular exports
		const exports = sourceFile.getExportDeclarations();
		for (const exportDecl of exports) {
			const exportModuleSpecifier = exportDecl.getModuleSpecifierValue();
			if (exportModuleSpecifier) {
				this.analyzeImport(
					exportModuleSpecifier,
					baseDir,
					exportDecl as unknown as ImportDeclaration,
					depth + 1,
				);
			}
		}

		// Process namespace exports (export * from)
		const exportStars = sourceFile
			.getExportDeclarations()
			.filter(
				(exp) => exp.isNamespaceExport() && exp.getModuleSpecifierValue(),
			);
		for (const exportStar of exportStars) {
			const starModuleSpecifier = exportStar.getModuleSpecifierValue();
			if (starModuleSpecifier) {
				this.analyzeImport(
					starModuleSpecifier,
					baseDir,
					exportStar as unknown as ImportDeclaration,
					depth + 1,
				);
			}
		}
	}

	/**
	 * Analyzes the source files of a project
	 * @param tsProject The TypeScript project
	 * @param projectRoot The root of the project
	 * @param options The generator options
	 * @param workspaceRoot The root of the workspace
	 */
	public analyzeProjectSourceFiles(
		tsProject: Project,
		projectRoot: string,
		options: AnalyzeDepsGeneratorSchema,
		workspaceRoot: string,
	) {
		const projectSourceFiles = tsProject.addSourceFilesAtPaths([
			path.join(projectRoot, "**/*.ts"),
			...(options.targetLibs?.map((lib) =>
				path.join(workspaceRoot, lib, "**/*.ts"),
			) ?? []),
			`!${path.join(projectRoot, "node_modules/**/*")}`,
			`!${path.join(projectRoot, "dist/**/*")}`,
			`!${path.join(projectRoot, "build/**/*")}`,
			`!${path.join(projectRoot, "**/*.spec.ts")}`,
			`!${path.join(projectRoot, "**/*.test.ts")}`,
			`!${path.join(projectRoot, "**/*.spec.tsx")}`,
			`!${path.join(projectRoot, "**/*.test.tsx")}`,
		]);

		for (const sourceFile of projectSourceFiles) {
			const baseDir = path.dirname(sourceFile.getFilePath());
			const imports = sourceFile.getImportDeclarations();
			for (const importDecl of imports) {
				const moduleSpecifier = importDecl.getModuleSpecifierValue();
				this.analyzeImport(moduleSpecifier, baseDir, importDecl);
			}

			const exports = sourceFile.getExportDeclarations();
			for (const exportDecl of exports) {
				const moduleSpecifier = exportDecl.getModuleSpecifierValue();
				if (moduleSpecifier) {
					this.analyzeImport(
						moduleSpecifier,
						baseDir,
						exportDecl as unknown as ImportDeclaration,
					);
				}
			}
		}
	}

	/**
	 * Gets the dependency analysis
	 * @returns The dependency analysis
	 */
	public getAnalysis(): DependencyAnalysis {
		return this.analysis;
	}

	/**
	 * Gets the used dependencies
	 * @returns The used dependencies and dev dependencies
	 */
	public getUsedDependencies(): UsedDependencies {
		const usedDependencies: { [key: string]: string } = {};
		const usedDevDependencies: { [key: string]: string } = {};
		for (const [moduleName] of this.analysis.externalImports) {
			if (this.packageJson.dependencies?.[moduleName]) {
				usedDependencies[moduleName] =
					this.packageJson.dependencies[moduleName];
			} else if (this.packageJson.devDependencies?.[moduleName]) {
				usedDevDependencies[moduleName] =
					this.packageJson.devDependencies[moduleName];
			}
		}
		return { usedDependencies, usedDevDependencies };
	}

	/**
	 * Writes the analysis output to a file
	 * @param projectRoot The root of the project
	 */
	public writeOutput(projectRoot: string): void {
		const { usedDependencies, usedDevDependencies } =
			this.getUsedDependencies();
		const outputPath = path.join(projectRoot, "opdep.json");
		const output = {
			dependencies: usedDependencies,
			devDependencies: usedDevDependencies,
			analysis: {
				externalImports: Object.fromEntries(
					Array.from(this.analysis.externalImports.entries()).map(
						([key, value]) => [key, Array.from(value)],
					),
				),
				internalImports: Array.from(this.analysis.internalImports),
				internalAliasImports: Array.from(this.analysis.internalAliasImports),
			},
		};
		this.fileSystemManager.writeJsonToTree(outputPath, output);
	}
}

/**
 * Class responsible for managing workspace libraries
 */
class WorkspaceLibraryManager {
	private tree: Tree;
	private libraries: Map<string, WorkspaceLibrary>;

	/**
	 * Creates a new WorkspaceLibraryManager
	 * @param tree The file system tree
	 */
	constructor(tree: Tree) {
		this.tree = tree;
		this.libraries = new Map<string, WorkspaceLibrary>();
	}

	/**
	 * Gets all libraries in the workspace
	 * @returns A map of library names to library objects
	 */
	public getWorkspaceLibraries(): Map<string, WorkspaceLibrary> {
		if (this.libraries.size === 0) {
			this.loadWorkspaceLibraries();
		}
		return this.libraries;
	}

	/**
	 * Loads all libraries from the workspace
	 */
	private loadWorkspaceLibraries(): void {
		const projects = getProjects(this.tree);

		for (const [name, config] of projects.entries()) {
			if (config.projectType === "library") {
				this.libraries.set(name, {
					name,
					root: config.root,
				});
			}
		}
	}
}

/**
 * Service responsible for analyzing dependencies
 */
class DependencyAnalysisService {
	private tree: Tree;
	private fileSystemManager: FileSystemManager;
	private tsConfigManager: TypeScriptConfigManager;
	private packageJsonManager: PackageJsonManager;
	private workspaceLibraryManager: WorkspaceLibraryManager;

	/**
	 * Creates a new DependencyAnalysisService
	 * @param tree The file system tree
	 */
	constructor(tree: Tree) {
		this.tree = tree;
		this.fileSystemManager = new FileSystemManager(tree);
		this.tsConfigManager = new TypeScriptConfigManager(this.fileSystemManager);
		this.packageJsonManager = new PackageJsonManager(this.fileSystemManager);
		this.workspaceLibraryManager = new WorkspaceLibraryManager(tree);
	}

	/**
	 * Analyzes dependencies for a project
	 * @param options The generator options
	 */
	public async analyzeDependencies(options: AnalyzeDepsGeneratorSchema): Promise<void> {
		const projects = getProjects(this.tree);
		const project = projects.get(options.projectName);
		if (!project) {
			throw new Error(`Project ${options.projectName} not found in workspace`);
		}
		const projectRoot = project.root;

		// Get root tsconfig and workspace libs
		const tsConfig = this.tsConfigManager.getRootTsConfig();
		logger.info(`Root tsConfig content: ${JSON.stringify(tsConfig, null, 2)}`);

		// Get package.json for the project
		const packageJson = this.packageJsonManager.analyzeProjectDependencies(projectRoot);

		const workspaceLibs = this.workspaceLibraryManager.getWorkspaceLibraries();
		const workspaceRoot = this.fileSystemManager.getRoot();

		// Create analyzer instance
		const analyzer = new DependencyAnalyzer(
			this.tree,
			tsConfig,
			packageJson,
			workspaceLibs,
		);

		// Create ts-morph project
		const tsProject = new Project({
			// Type assertion to satisfy ts-morph's expected type for compilerOptions
			compilerOptions: (tsConfig as { compilerOptions?: Record<string, unknown> })
				.compilerOptions as unknown as ProjectOptions["compilerOptions"],
			skipAddingFilesFromTsConfig: true,
		});

		logger.info(`Project analysis started: ${options.projectName}`);
		analyzer.analyzeProjectSourceFiles(
			tsProject,
			projectRoot,
			options,
			workspaceRoot,
		);
		logger.info(`Analyzed ${analyzer.analyzedPaths.size} paths`);

		analyzer.writeOutput(projectRoot);
		await formatFiles(this.tree);

		const { usedDependencies, usedDevDependencies } =
			analyzer.getUsedDependencies();
		logger.info(`Analysis complete for ${options.projectName}`);
		logger.info(
			`Found ${Object.keys(usedDependencies).length} used dependencies`,
		);
		logger.info(
			`Found ${Object.keys(usedDevDependencies).length} used dev dependencies`,
		);
	}
}

export async function analyzeDepsGenerator(
	tree: Tree,
	options: AnalyzeDepsGeneratorSchema,
) {
	const service = new DependencyAnalysisService(tree);
	await service.analyzeDependencies(options);
}

export default analyzeDepsGenerator;
