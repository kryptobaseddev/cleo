/**
 * forge-ts configuration for CLEO documentation generation.
 *
 * Enforces TSDoc coverage as a build gate and generates all documentation
 * artifacts from source code in one pass.
 */
declare const _default: {
    rootDir: string;
    tsconfig: string;
    outDir: string;
    enforce: {
        enabled: boolean;
        minVisibility: string;
        strict: boolean;
        rules: {
            "require-example": string;
            "require-package-doc": string;
            "require-param": string;
            "require-returns": string;
            "require-class-member-doc": string;
            "require-interface-member-doc": string;
        };
    };
    gen: {
        formats: string[];
        llmsTxt: boolean;
        ssgTarget: string;
    };
    project: {
        packageName: string;
    };
};
export default _default;
//# sourceMappingURL=forge-ts.config.d.ts.map