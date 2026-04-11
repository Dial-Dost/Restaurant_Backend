const fs = require('fs');

function readJson(path) {
  const raw = fs.readFileSync(path);
  let text = raw.toString('utf8');

  if (text.includes('\u0000')) {
    text = raw.toString('utf16le');
  }

  // PowerShell redirection can emit a leading BOM/signature byte and null padding.
  text = text.replace(/^\uFEFF/, '').replace(/\u0000/g, '');
  const jsonStart = text.indexOf('{');
  if (jsonStart > 0) {
    text = text.slice(jsonStart);
  }

  return JSON.parse(text);
}

function main() {
  const schema = readJson('./scripts/supabase_schema_snapshot.json');
  const constraints = readJson('./scripts/supabase_constraints_snapshot.json');

  const pkByTable = {};
  for (const row of constraints.primary_keys) {
    if (!pkByTable[row.table_name]) pkByTable[row.table_name] = [];
    pkByTable[row.table_name].push(row.column_name);
  }

  const fkByTable = {};
  for (const row of constraints.foreign_keys) {
    if (!fkByTable[row.table_name]) fkByTable[row.table_name] = [];
    fkByTable[row.table_name].push(
      `${row.column_name}->${row.foreign_table_name}.${row.foreign_column_name}`
    );
  }

  const interesting = [
    'Restaurant',
    'Outlets',
    'Employees',
    'Login',
    'Customers',
    'Tables',
    'Bookings',
    'Orders',
    'Bills',
    'Audit_logs',
    'Feedback_entries',
    'Roles',
    'Actions',
  ];

  const result = {
    table_count: schema.table_count,
    tables: schema.tables,
    interesting: interesting.map((table) => ({
      table,
      columns: (schema.columns[table] || []).map(
        (c) => `${c.name}:${c.type}${c.nullable ? '?' : ''}`
      ),
      primary_key: pkByTable[table] || [],
      foreign_keys: fkByTable[table] || [],
    })),
  };

  console.log(JSON.stringify(result, null, 2));
}

main();
