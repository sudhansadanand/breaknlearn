// Node module-resolution hook for the job runners: lets workspace TypeScript sources use the
// extensionless relative imports that the bundler-mode tsconfig allows (./foo -> ./foo.ts).
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (relative && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return await next(`${specifier}.ts`, context);
      } catch {
        return next(`${specifier}/index.ts`, context);
      }
    }
    throw err;
  }
}
