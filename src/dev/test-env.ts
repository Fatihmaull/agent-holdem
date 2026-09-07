/**
 * Environment a test needs before the modules under test are loaded.
 *
 * Some server modules refuse to load without a connection string, which is the
 * right behaviour for a server and an obstacle for a test that never runs a
 * query. Importing this first supplies a placeholder without weakening the
 * check itself. Import order is the mechanism: a module's dependencies are
 * evaluated before it is, so this runs before anything that reads the value.
 */
process.env.DATABASE_URL ||= 'postgres://placeholder/placeholder';
