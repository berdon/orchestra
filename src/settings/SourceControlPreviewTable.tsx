import { getSourceControlOriginLabel, type SourceControlPreviewRow } from "../lib/sourceControlSettings";

interface SourceControlPreviewTableProps {
  rows: SourceControlPreviewRow[];
  dataRole?: string;
}

export function SourceControlPreviewTable({ rows, dataRole }: SourceControlPreviewTableProps) {
  return (
    <div className="bridge-diagnostics-table-wrap">
      <table className="task-table" data-role={dataRole}>
        <thead>
          <tr>
            <th>Scenario</th>
            <th>git user.name</th>
            <th>Name origin</th>
            <th>git user.email</th>
            <th>Email origin</th>
            <th>Warnings</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-role={`source-control-preview-row-${row.key}`}>
              <td>{row.label}</td>
              <td><code>{row.gitUserName.resolved ?? "unset"}</code></td>
              <td>{getSourceControlOriginLabel(row.gitUserName.origin)}</td>
              <td><code>{row.gitEmail.resolved ?? "unset"}</code></td>
              <td>{getSourceControlOriginLabel(row.gitEmail.origin)}</td>
              <td>{row.warnings.length ? row.warnings.join(" · ") : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
