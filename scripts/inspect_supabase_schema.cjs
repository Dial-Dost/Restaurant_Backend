const { Client } = require('pg');

async function main() {
  const connectionString = process.env.SUPABASE_DIRECT_URL || process.env.DATABASE_URL || process.env.DIRECT_URL;
  if (!connectionString) {
    throw new Error('SUPABASE_DIRECT_URL (or DATABASE_URL / DIRECT_URL) is required');
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  const tableCountResult = await client.query(
    "select count(*)::int as count from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'"
  );

  const tablesResult = await client.query(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name"
  );

  const columnsResult = await client.query(
    "select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position"
  );

  const columnsByTable = {};
  for (const row of columnsResult.rows) {
    if (!columnsByTable[row.table_name]) {
      columnsByTable[row.table_name] = [];
    }
    columnsByTable[row.table_name].push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
    });
  }

  console.log(
    JSON.stringify(
      {
        table_count: tableCountResult.rows[0].count,
        tables: tablesResult.rows.map((r) => r.table_name),
        columns: columnsByTable,
      },
      null,
      2
    )
  );

  await client.end();
}

main().catch((error) => {
  console.error('inspect_supabase_schema_failed', error.message);
  process.exit(1);
});
