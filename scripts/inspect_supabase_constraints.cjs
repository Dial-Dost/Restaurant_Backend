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

  const pkRows = await client.query(`
    select
      tc.table_name,
      kcu.column_name,
      tc.constraint_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
      and tc.table_schema = kcu.table_schema
    where tc.table_schema = 'public'
      and tc.constraint_type = 'PRIMARY KEY'
    order by tc.table_name, kcu.ordinal_position;
  `);

  const fkRows = await client.query(`
    select
      tc.table_name,
      kcu.column_name,
      ccu.table_name as foreign_table_name,
      ccu.column_name as foreign_column_name,
      tc.constraint_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
      and tc.table_schema = kcu.table_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
      and ccu.table_schema = tc.table_schema
    where tc.table_schema = 'public'
      and tc.constraint_type = 'FOREIGN KEY'
    order by tc.table_name, kcu.ordinal_position;
  `);

  const uniqueRows = await client.query(`
    select
      tc.table_name,
      kcu.column_name,
      tc.constraint_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
      and tc.table_schema = kcu.table_schema
    where tc.table_schema = 'public'
      and tc.constraint_type = 'UNIQUE'
    order by tc.table_name, tc.constraint_name, kcu.ordinal_position;
  `);

  console.log(
    JSON.stringify(
      {
        primary_keys: pkRows.rows,
        foreign_keys: fkRows.rows,
        unique_constraints: uniqueRows.rows,
      },
      null,
      2
    )
  );

  await client.end();
}

main().catch((error) => {
  console.error('inspect_supabase_constraints_failed', error.message);
  process.exit(1);
});
