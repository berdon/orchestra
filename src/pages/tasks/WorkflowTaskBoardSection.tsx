import type { AgentSummary, RoleSummary } from "../../types";
import { TaskCompactCard } from "./TaskCompactCard";
import type { TaskWorkflowSection } from "./taskBoardModel";
import { resolveTaskAssigneeLabel } from "./taskBoardModel";

interface WorkflowTaskBoardSectionProps {
  section: TaskWorkflowSection;
  agents: AgentSummary[];
  roles: RoleSummary[];
  onOpenTask: (taskId: string) => void;
}

export function WorkflowTaskBoardSection({ section, agents, roles, onOpenTask }: WorkflowTaskBoardSectionProps) {
  return (
    <section className="task-board-section" data-role="workflow-task-section">
      <div className="task-board-section__header">
        <div>
          <p className="eyebrow">Workflow</p>
          <h3>{section.workflowName}</h3>
        </div>
      </div>

      <div className="task-board-scroll">
        <div className="task-lane-board">
          {section.lanes.map((lane) => (
            <section className="task-lane-column" key={lane.laneId}>
              <div className="task-lane-column__header">
                <strong>{lane.laneName}</strong>
                <span>{lane.tasks.length}</span>
              </div>
              <div className="task-lane-column__list">
                {lane.tasks.map((task) => (
                  <TaskCompactCard
                    assigneeLabel={resolveTaskAssigneeLabel(task, agents, roles)}
                    key={task.id}
                    task={task}
                    onOpen={onOpenTask}
                  />
                ))}
              </div>
            </section>
          ))}

          <section className="task-lane-column task-lane-column--done">
            <div className="task-lane-column__header">
              <strong>Done</strong>
              <span>{section.doneTasks.length}</span>
            </div>
            <div className="task-lane-column__list">
              {section.doneTasks.map((task) => (
                <TaskCompactCard
                  assigneeLabel={resolveTaskAssigneeLabel(task, agents, roles)}
                  key={task.id}
                  task={task}
                  onOpen={onOpenTask}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
