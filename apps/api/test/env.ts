/**
 * Shared test environment: the test database URL (never a real database).
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://agreementhub:agreementhub@127.0.0.1:5432/agreementhub_test';

/** Guard used by anything that mutates the schema/data. */
export function assertTestDatabase(url: string = TEST_DATABASE_URL): void {
  const name = new URL(url).pathname.slice(1);
  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to run against non-test database "${name}". ` +
        'Set TEST_DATABASE_URL to a database whose name contains "test".',
    );
  }
}
