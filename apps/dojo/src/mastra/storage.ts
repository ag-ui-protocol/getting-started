import { LibSQLStore } from "@mastra/libsql";
import { DynamoDBStore } from "@mastra/dynamodb";

export function getStorage(): LibSQLStore | DynamoDBStore {
  if (process.env.DYNAMODB_TABLE_NAME) {
    return new DynamoDBStore({
      name: "dynamodb",
      config: {
        id: 'storage-dynamodb',
        tableName: process.env.DYNAMODB_TABLE_NAME,
      },
    });
  } else {
    return new LibSQLStore({
      id: 'storage-memory',
      // File-backed (not ":memory:"): with connection pooling, an in-memory
      // libsql gives each connection its own empty DB, so migrated tables
      // (e.g. mastra_workflow_snapshot) vanish and resume can't load the
      // suspended snapshot. A file keeps one shared, migrated DB.
      url: process.env.LIBSQL_URL || "file:./.mastra-demo.db",
    });
  }
}
