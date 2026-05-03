import { useEffect, useState } from "react";

type FeatureCard = {
  title: string;
  body: string;
  label: string;
};

type WorkflowGalleryShot = {
  src: string;
  alt: string;
  eyebrow: string;
  title: string;
  copy: string;
};

type ProofShot = {
  src: string;
  alt: string;
  eyebrow: string;
  title: string;
  copy: string;
  className?: string;
};

const featureCards: FeatureCard[] = [
  {
    title: "Custom workflows",
    body: "Build kanban-style flows with effectively unlimited lane and transition shapes, explicit ownership, intervention states, and approval gates.",
    label: "Workflow engine",
  },
  {
    title: "Projects with multi-repo support",
    body: "Attach multiple repositories to the same project or task, keep source context visible, and execute in native task-scoped worktrees.",
    label: "Repos + worktrees",
  },
  {
    title: "Persistent agents + ephemeral role sessions",
    body: "Keep long-lived specialist agents around, then fan out disposable role-owned work exactly where it belongs.",
    label: "Worker model",
  },
  {
    title: "Supervisor control by natural language",
    body: "Ask the supervisor to create tasks, coordinate delivery, steer runtime sessions, or route review work without dropping into brittle admin flows.",
    label: "Operator control",
  },
  {
    title: "Pi underneath",
    body: "Orchestra is built on Pi, so it can run with local or cloud models while keeping extensions, plugin support, prompt/runtime composition, and deeper customization first-class.",
    label: "Extensible core",
  },
  {
    title: "Agent-to-agent coordination",
    body: "Let agents communicate across tasks and repositories so handoffs, follow-up work, and cross-project coordination stay inside the product instead of leaking into side channels.",
    label: "Coordination",
  },
  {
    title: "Rich permissions",
    body: "Grant narrowly scoped capabilities or full supervisor access across tasks, workflows, agents, policies, logs, projects, and more.",
    label: "Least privilege",
  },
  {
    title: "Telegram orchestration",
    body: "Bind Telegram to the supervisor for command routing, coordination, notifications, and chat-based project control.",
    label: "Chat ops",
  },
  {
    title: "Feature-parity mobile experience",
    body: "Review, navigate, and orchestrate work away from the desk without falling back to a toy companion UI.",
    label: "Mobile",
  },
  {
    title: "Themes and customization",
    body: "Tune the workbench feel with built-in themes and keep the overall operator environment aligned to your team.",
    label: "Workbench polish",
  },
  {
    title: "Safe secret support",
    body: "Share sensitive values across tasks safely, with product-level controls instead of copying secrets through comments or ad hoc chat.",
    label: "Security",
  },
];

const workflowGalleryShots: WorkflowGalleryShot[] = [
  {
    src: "/github-landing/workflow-lanes.png",
    alt: "Orchestra Development workflow lanes shown in the workflow settings view.",
    eyebrow: "Development workflow",
    title: "Map the lane contract before work starts",
    copy: "The workflow definition makes the path explicit: plan the work, implement it, verify it, and stop for review when the lane says a human should decide what happens next.",
  },
  {
    src: "/github-landing/workflow-ticket-board.png",
    alt: "Orchestra tasks page showing work distributed across workflow lanes.",
    eyebrow: "Tasks page",
    title: "Watch the ticket move through the lane board",
    copy: "The tasks view keeps work organized by workflow stage so you can scan ownership, queue state, and progress without losing the wider delivery picture.",
  },
  {
    src: "/github-landing/task-detail.png",
    alt: "Orchestra task detail page showing a task summary, description, and comments.",
    eyebrow: "Task detail",
    title: "Open the task and keep the context attached",
    copy: "When you drill into a task, the description, discussion, workflow state, and execution context stay connected to the exact lane the work is in.",
  },
];

const proofShots: ProofShot[] = [
  {
    src: "/github-landing/workflow-controls.png",
    alt: "Orchestra workflow lane editor showing worktree and approval controls.",
    eyebrow: "Workflow controls",
    title: "Set lane rules where the process is defined",
    copy: "Worktree choices, ownership, failure routing, and approval requirements live inside the workflow instead of being hidden in process docs or tribal knowledge.",
    className: "github-proof-card--wide",
  },
  {
    src: "/github-landing/repo-worktrees.png",
    alt: "Orchestra repo files panel showing multiple repositories and a task worktree.",
    eyebrow: "Repo context",
    title: "Tasks stay grounded in repository state",
    copy: "Keep task-linked repositories, tracked files, and worktree context visible while work is in flight.",
  },
  {
    src: "/github-landing/supervisor-chat-desktop.png",
    alt: "Orchestra desktop supervisor chat session.",
    eyebrow: "Supervisor chat",
    title: "Natural-language control over the whole system",
    copy: "Create tasks, coordinate delivery, review blockers, and keep active work moving from the supervisor’s persistent chat session.",
  },
  {
    src: "/github-landing/permissions.png",
    alt: "Orchestra permissions editor showing effective permissions and supervisor access.",
    eyebrow: "Permissions",
    title: "Granular by default, powerful when needed",
    copy: "Protected actions stay explicit. Supervisor access is durable, visible, and intentionally granted.",
  },
  {
    src: "/github-landing/telegram.png",
    alt: "Orchestra Telegram channel setup screen.",
    eyebrow: "Telegram",
    title: "Wire chat ops directly into supervision",
    copy: "Connect channels for commands, notifications, and remote orchestration without inventing a separate control plane.",
  },
  {
    src: "/github-landing/themes.png",
    alt: "Orchestra general settings screen showing theme selection.",
    eyebrow: "Themes",
    title: "Customize the operator workbench",
    copy: "Tune the workbench so teams can keep a consistent operating environment instead of settling for a generic admin shell.",
  },
  {
    src: "/github-landing/mobile.png",
    alt: "Orchestra mobile tasks view.",
    eyebrow: "Mobile",
    title: "Orchestrate from anywhere",
    copy: "The same workbench ideas carry cleanly onto mobile so you can review and steer work away from the desktop.",
  },
];

function MarkIcon() {
  return (
    <span className="github-brand-mark" aria-hidden="true">
      <img src="/github-landing/orchestra-logo.png" alt="" />
    </span>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 10h12" />
      <path d="m10.5 4 5.5 6-5.5 6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4.5 10 3.4 3.4L15.5 5.8" />
    </svg>
  );
}

export function GitHubLandingPage() {
  const [activeWorkflowShot, setActiveWorkflowShot] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mediaQuery.matches) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setActiveWorkflowShot((current) => (current + 1) % workflowGalleryShots.length);
    }, 3200);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const activeWorkflowGalleryShot = workflowGalleryShots[activeWorkflowShot];

  return (
    <div className="github-landing" data-role="github-landing-root">
      <div className="github-landing__backdrop" aria-hidden="true" />

      <header className="github-topbar">
        <a className="github-brand" href="#top" aria-label="Orchestra GitHub landing page">
          <MarkIcon />
          <span>
            <strong>Orchestra</strong>
            <small>Operator workbench</small>
          </span>
        </a>

        <nav className="github-topbar__nav" aria-label="Page sections">
          <a href="#quickstart">Quick start</a>
          <a href="#workflow">Workflow</a>
          <a href="#features">Features</a>
        </nav>

        <div className="github-topbar__actions">
          <a className="github-button github-button--ghost" href="https://github.com/berdon/orchestra" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a
            className="github-button github-button--primary"
            data-role="github-hero-download"
            href="https://hnsn.io/Orchestra.zip"
            target="_blank"
            rel="noreferrer"
          >
            Download
          </a>
        </div>
      </header>

      <main id="top">
        <section className="github-hero github-shell-section">
          <div className="github-hero__copy">
            <p className="github-eyebrow">Standalone GitHub landing page</p>
            <h1>Run a company, organization, or project with customizable workflows, agents, and live human control.</h1>
            <p className="github-lead">
              Orchestra keeps tasks, workflows, repos, worktrees, permissions, sessions, channels, and operator oversight in one workbench.
              It is built for teams that want real orchestration instead of a thin issue tracker wrapped around chat.
            </p>

            <ul className="github-check-list" aria-label="Core Orchestra value">
              <li><CheckIcon /> Kanban-style workflows with flexible lane structure, intervention states, and approval requirements</li>
              <li><CheckIcon /> Multi-repo projects with task-linked context and native worktree-aware execution</li>
              <li><CheckIcon /> Persistent supervisor + agent runtime with disposable role-owned sessions when you need burst capacity</li>
            </ul>

            <div className="github-cta-row">
              <a
                className="github-button github-button--primary"
                data-role="github-hero-download-secondary"
                href="https://hnsn.io/Orchestra.zip"
                target="_blank"
                rel="noreferrer"
              >
                Download Orchestra
                <ArrowIcon />
              </a>
              <a
                className="github-button github-button--ghost"
                data-role="github-hero-github"
                href="https://github.com/berdon/orchestra"
                target="_blank"
                rel="noreferrer"
              >
                View the GitHub mirror
              </a>
            </div>

            <div className="github-stat-strip" aria-label="Headline capabilities">
              <article>
                <strong>Flexible lanes</strong>
                <span>Custom workflows, not a fixed funnel</span>
              </article>
              <article>
                <strong>Multi-repo</strong>
                <span>Task-linked repos + native worktrees</span>
              </article>
              <article>
                <strong>Supervisor</strong>
                <span>Natural requests across the whole stack</span>
              </article>
              <article>
                <strong>Telegram + mobile</strong>
                <span>Operate away from the desktop</span>
              </article>
            </div>
          </div>

          <div className="github-hero__media">
            <figure className="github-screenshot-card github-screenshot-card--hero">
              <img
                data-role="github-hero-screenshot"
                src="/github-landing/workflow-ticket-board.png"
                alt="Orchestra tasks page showing work distributed across workflow lanes."
              />
              <figcaption>
                <span>Tasks page</span>
                <strong>Track the workflow lane, owner, and state from the same board</strong>
              </figcaption>
            </figure>

            <div className="github-hero__floating-note">
              <p className="github-eyebrow">What makes it different</p>
              <strong>Workflow definitions, lane movement, task detail, repo state, and approvals all stay connected.</strong>
            </div>
          </div>
        </section>

        <section className="github-quickstart github-shell-section" id="quickstart">
          <div className="github-section-heading">
            <p className="github-eyebrow">Quick start</p>
            <h2>Ask the supervisor to set up the project and create the work</h2>
            <p>
              Orchestra is designed so a fresh workspace can begin with plain-English requests instead of a long sequence of setup clicks.
            </p>
          </div>

          <div className="github-quickstart__grid">
            <article className="github-quickstart-card">
              <p className="github-eyebrow">Step 1</p>
              <div className="github-quickstart-card__prompt">
                <span>Message the supervisor</span>
                <strong>
                  “Create a new orchestra project and add the <a href="https://github.com/berdon/orchestra" target="_blank" rel="noreferrer">https://github.com/berdon/orchestra</a> repository to it.”
                </strong>
              </div>
              <ul className="github-bullet-list github-bullet-list--compact">
                <li>Creates the project scaffold in Orchestra</li>
                <li>Adds the GitHub repository into the project context</li>
                <li>Keeps the repo ready for task-linked work and worktree-aware execution</li>
              </ul>
            </article>

            <article className="github-quickstart-card">
              <p className="github-eyebrow">Step 2</p>
              <div className="github-quickstart-card__prompt">
                <span>Follow up with the supervisor</span>
                <strong>
                  “Create a dev workflow task to fix the bug where new projects don’t automatically show in the nav project switcher.”
                </strong>
              </div>
              <ul className="github-bullet-list github-bullet-list--compact">
                <li>Creates a Development workflow task with the bug context attached</li>
                <li>Routes the task into the right workflow lane for implementation</li>
                <li>Keeps the next worker focused on the actual fix instead of setup overhead</li>
              </ul>
            </article>

            <aside className="github-quickstart-meta">
              <article>
                <p className="github-eyebrow">Model freedom</p>
                <h3>Works with local or cloud models</h3>
                <p>Because Orchestra uses the Pi coding agent underneath, the orchestration layer is not tied to a single hosted provider.</p>
              </article>
              <article>
                <p className="github-eyebrow">Cross-agent collaboration</p>
                <h3>Coordinate across tasks and repositories</h3>
                <p>Agents can hand work to other agents, share context across related tasks, and coordinate multi-repo delivery without leaving the system.</p>
              </article>
            </aside>
          </div>
        </section>

        <section className="github-pillars github-shell-section" aria-label="Core pillars">
          <article>
            <span>01</span>
            <h2>Custom workflows</h2>
            <p>Infinite-looking lane and flow options with first-class intervention and approval steps.</p>
          </article>
          <article>
            <span>02</span>
            <h2>Execution context</h2>
            <p>Projects, repositories, worktrees, files, and sessions remain tied to the task that owns them.</p>
          </article>
          <article>
            <span>03</span>
            <h2>Human-in-the-loop</h2>
            <p>Supervisors can steer the system through natural requests while permissions keep protected actions explicit.</p>
          </article>
          <article>
            <span>04</span>
            <h2>Operate anywhere</h2>
            <p>Desktop, mobile, and Telegram all participate in the same orchestration model.</p>
          </article>
        </section>

        <section className="github-proof github-shell-section" id="workflow">
          <div className="github-section-heading">
            <p className="github-eyebrow">Workflow walkthrough</p>
            <h2>See how work moves from lane definition to task execution</h2>
            <p>
              Start with the Development workflow itself, move into the tasks board where tickets progress through the lanes, then open the
              task detail to keep the discussion and execution context attached to the work.
            </p>
          </div>

          <div className="github-workflow-gallery" data-role="github-workflow-gallery">
            <figure className="github-workflow-gallery__frame">
              {workflowGalleryShots.map((shot, index) => (
                <img
                  key={shot.title}
                  className="github-workflow-gallery__image"
                  data-active={index === activeWorkflowShot ? "true" : "false"}
                  data-role="github-workflow-gallery-image"
                  src={shot.src}
                  alt={shot.alt}
                  loading="lazy"
                />
              ))}
            </figure>

            <div className="github-workflow-gallery__copy">
              <p className="github-eyebrow">{activeWorkflowGalleryShot.eyebrow}</p>
              <h3>{activeWorkflowGalleryShot.title}</h3>
              <p>{activeWorkflowGalleryShot.copy}</p>

              <div className="github-workflow-gallery__dots" aria-label="Workflow gallery slides">
                {workflowGalleryShots.map((shot, index) => (
                  <button
                    key={shot.title}
                    type="button"
                    className={index === activeWorkflowShot ? "github-workflow-gallery__dot github-workflow-gallery__dot--active" : "github-workflow-gallery__dot"}
                    aria-label={`Show ${shot.eyebrow.toLowerCase()} screenshot`}
                    aria-pressed={index === activeWorkflowShot}
                    onClick={() => setActiveWorkflowShot(index)}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="github-section-heading github-section-heading--compact github-section-heading--post-gallery">
            <p className="github-eyebrow">More product surfaces</p>
            <h2>Keep the rest of the operator workbench in view</h2>
            <p>
              Beyond the workflow path itself, Orchestra keeps repo context, supervisor control, permissions, Telegram, themes, and mobile
              orchestration inside the same product surface.
            </p>
          </div>

          <div className="github-proof-grid" data-role="github-proof-grid">
            {proofShots.map((shot) => (
              <figure className={`github-proof-card ${shot.className ?? ""}`.trim()} key={shot.title}>
                <img src={shot.src} alt={shot.alt} loading="lazy" />
                <figcaption>
                  <p className="github-eyebrow">{shot.eyebrow}</p>
                  <h3>{shot.title}</h3>
                  <p>{shot.copy}</p>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className="github-features github-shell-section" id="features">
          <div className="github-section-heading">
            <p className="github-eyebrow">Core product surface</p>
            <h2>Designed for dense orchestration, easy scanning, and real operator control</h2>
            <p>
              Orchestra is not just task tracking. It is the execution layer around workflows, workers, runtime sessions, review loops,
              repos, channels, and privileged operations.
            </p>
          </div>

          <div className="github-feature-grid">
            {featureCards.map((feature) => (
              <article className="github-feature-card" key={feature.title}>
                <p className="github-feature-card__label">{feature.label}</p>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="github-story github-shell-section">
          <div className="github-story__copy">
            <p className="github-eyebrow">Workflow story</p>
            <h2>Completely customizable kanban-style flows</h2>
            <p>
              Use Orchestra when your process cannot be flattened into a single canned pipeline. Define lanes around users, roles, or agents;
              decide what success and failure do next; require human approval before advancing; and pause execution for intervention without
              losing the surrounding task context.
            </p>
            <div className="github-story__list">
              <article>
                <strong>Ownership stays explicit</strong>
                <p>Every lane declares who owns it and what runtime shape it needs.</p>
              </article>
              <article>
                <strong>Worktree choices are workflow-native</strong>
                <p>Separate worker-specific worktrees can be part of the lane contract instead of tribal process.</p>
              </article>
              <article>
                <strong>Approval gates are first-class</strong>
                <p>Success can stop for a human before the workflow moves forward.</p>
              </article>
            </div>
          </div>
          <figure className="github-story__media github-screenshot-card">
            <img src="/github-landing/workflow-controls.png" alt="Orchestra workflow controls for worktrees and user approval requirements." loading="lazy" />
          </figure>
        </section>

        <section className="github-story github-story--reverse github-shell-section">
          <figure className="github-story__media github-screenshot-card">
            <img src="/github-landing/repo-worktrees.png" alt="Orchestra task repo files panel with multiple repositories and worktree information." loading="lazy" />
          </figure>
          <div className="github-story__copy">
            <p className="github-eyebrow">Execution context</p>
            <h2>Parallel work without repo chaos</h2>
            <p>
              Projects can span multiple repositories, tasks can carry their own repository references, and worker execution can happen in
              native worktrees tied back to the task. That means less guessing about which checkout, file, or repo a worker actually used.
            </p>
            <div className="github-inline-cards">
              <article>
                <strong>Multi-repo by default</strong>
                <p>Keep related codebases and documents inside the same orchestration surface.</p>
              </article>
              <article>
                <strong>Task-linked files</strong>
                <p>Surface the exact docs, plans, or implementation files that matter to current work.</p>
              </article>
              <article>
                <strong>Worktree-aware runtime</strong>
                <p>Separate execution contexts stay visible instead of disappearing into shell history.</p>
              </article>
            </div>
          </div>
        </section>

        <section className="github-duo github-shell-section">
          <div className="github-duo__copy">
            <p className="github-eyebrow">Control plane</p>
            <h2>Supervisor control and rich permissions belong together</h2>
            <p>
              Natural-language control is only useful when the system can safely express what each actor may or may not do. Orchestra pairs
              a persistent supervisor session with a deep permission model so powerful actions stay visible, auditable, and intentional.
            </p>
            <ul className="github-bullet-list">
              <li>Create tasks, coordinate workers, and route follow-up work from the supervisor session</li>
              <li>Keep the same supervisor conversation available in the desktop workbench and the mobile layout</li>
              <li>Grant narrow protected actions or full supervisor access depending on the role</li>
            </ul>
          </div>
          <div className="github-duo__media">
            <figure className="github-screenshot-card">
              <img src="/github-landing/supervisor-chat-desktop.png" alt="Orchestra desktop supervisor chat session." loading="lazy" />
            </figure>
            <figure className="github-screenshot-card">
              <img src="/github-landing/supervisor-chat-mobile.png" alt="Orchestra mobile supervisor chat session." loading="lazy" />
            </figure>
          </div>
        </section>

        <section className="github-operate github-shell-section" id="operate">
          <div className="github-section-heading">
            <p className="github-eyebrow">Operate anywhere</p>
            <h2>Telegram, mobile, and a customizable workbench</h2>
            <p>
              Orchestra is built for real operational continuity. Stay in the desktop workbench when you can, but keep control when you move,
              chat, review, or need to quickly steer active work from somewhere else.
            </p>
          </div>

          <div className="github-operate__grid">
            <figure className="github-proof-card github-proof-card--compact">
              <img src="/github-landing/telegram.png" alt="Telegram settings in Orchestra." loading="lazy" />
              <figcaption>
                <h3>Telegram orchestration</h3>
                <p>Connect command handling, notifications, and supervisor chat to a channel teams already use.</p>
              </figcaption>
            </figure>
            <figure className="github-proof-card github-proof-card--compact">
              <img src="/github-landing/mobile.png" alt="Orchestra mobile tasks experience." loading="lazy" />
              <figcaption>
                <h3>Feature-parity mobile support</h3>
                <p>Review attention items, browse workflows, and keep project state close when the desktop is not in reach.</p>
              </figcaption>
            </figure>
            <figure className="github-proof-card github-proof-card--compact">
              <img src="/github-landing/themes.png" alt="Theme settings in Orchestra." loading="lazy" />
              <figcaption>
                <h3>Themes and customization</h3>
                <p>Make the workbench feel like a serious native tool instead of a generic browser admin panel.</p>
              </figcaption>
            </figure>
          </div>
        </section>

        <section className="github-security github-shell-section">
          <div className="github-section-heading github-section-heading--compact">
            <p className="github-eyebrow">Built for real operations</p>
            <h2>Extensible, secure, and built around visible workflow context</h2>
          </div>
          <div className="github-security__grid">
            <article>
              <h3>Pi-powered extensibility</h3>
              <p>Use Pi underneath for extensions, skills, plugin-style runtime composition, and deeper environment control.</p>
            </article>
            <article>
              <h3>Secure secret support</h3>
              <p>Share secrets across tasks through dedicated product support instead of leaking them through comments, shell history, or copy-paste workflows.</p>
            </article>
            <article>
              <h3>Workflow visibility</h3>
              <p>The landing page stays focused on what operators need to see: the workflow lanes, the task board, the task detail, and the control surfaces around them.</p>
            </article>
          </div>
        </section>

        <section className="github-footer-cta github-shell-section">
          <p className="github-eyebrow">Get started</p>
          <h2>Download Orchestra or inspect the mirror on GitHub</h2>
          <p>Explore the product, inspect the repository, and see how the orchestration model fits your workflow.</p>
          <div className="github-cta-row github-cta-row--centered">
            <a className="github-button github-button--primary" href="https://hnsn.io/Orchestra.zip" target="_blank" rel="noreferrer">
              Download .zip
              <ArrowIcon />
            </a>
            <a className="github-button github-button--ghost" href="https://github.com/berdon/orchestra" target="_blank" rel="noreferrer">
              Open GitHub mirror
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
