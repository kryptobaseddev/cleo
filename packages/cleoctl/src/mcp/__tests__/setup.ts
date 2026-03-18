/**
 * Jest Test Setup and Global Configuration
 *
 * Configures test environment, mocks, and global test utilities.
 *
 * @task T2921
 */

// Export to make this a module
export {};

// Global test setup
beforeAll(() => {
  // Configure environment variables for tests
  process.env.CLEO_TEST_MODE = 'true';

  // Only set CLEO_CLI_PATH if not already set by environment
  // This allows developers to override with their local installation
  if (!process.env.CLEO_CLI_PATH) {
    // Try to find cleo in PATH first (works for most installations)
    // If that fails, integration-setup.ts will try fallback paths
    process.env.CLEO_CLI_PATH = 'cleo';
  }
});

// Global test teardown
afterAll(() => {
  // Cleanup test environment
  delete process.env.CLEO_TEST_MODE;
});

// Reset mocks between tests
afterEach(() => {
  vi.clearAllMocks();
});
