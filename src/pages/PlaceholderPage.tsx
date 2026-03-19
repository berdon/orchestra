interface PlaceholderPageProps {
  eyebrow: string;
  title: string;
  body: string;
}

export function PlaceholderPage({ eyebrow, title, body }: PlaceholderPageProps) {
  return (
    <section className="panel-stack">
      <section className="panel panel--hero">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{body}</p>
      </section>

      <section className="panel panel--split">
        <div>
          <p className="eyebrow">Foundation</p>
          <h3>Session workspace</h3>
          <ul className="bullet-list">
            <li>Project switcher placeholder and stable left navigation</li>
            <li>Live transcript that stays pinned to the newest message</li>
            <li>Keyboard-first composer with optimistic pending states</li>
            <li>Per-session model selection from the app</li>
          </ul>
        </div>

        <div>
          <p className="eyebrow">Next orchestration layers</p>
          <h3>After sessions</h3>
          <ul className="bullet-list">
            <li>Projects and repositories</li>
            <li>Task workflow lanes and lane history</li>
            <li>Agents, roles, queues, and interruption semantics</li>
            <li>Multi-session orchestration and richer runtime controls</li>
          </ul>
        </div>
      </section>
    </section>
  );
}
