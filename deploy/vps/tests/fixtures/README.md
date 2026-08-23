# `rd-deploy status` fixtures

`deploy.yml` reads production health out of one string: whatever
`sudo /usr/local/sbin/rd-deploy status` prints. The wrapper is not in this
repository, so its output format is an **undeclared dependency** of both
workflows. These files pin it.

`ps_status_real.txt` is a byte-for-byte capture of the live VPS on 2026-08-22
(`cat -A`, `^I` = tab, `$` = end of line):

```
backend^IUp 15 hours (healthy)$
dashboard^IUp 15 hours (healthy)$
python^IUp 29 hours (healthy)$
valkey^IUp 29 hours (healthy)$
```

Note what it is **not**: no header row, and tab-separated rather than the
column-padded table `docker compose ps` prints on a terminal. The service name
is the first whitespace-delimited token, which is what `svc_line` keys on.

If someone changes the wrapper's `--format`, `test_status_parser.sh` fails.
Without these fixtures the first thing to notice would be a production deploy
that either hung until its health timeout or rolled back a perfectly good build.
The `_wide_*` fixtures keep the padded-table shape working too, so the parser
survives the wrapper being changed *back*.
