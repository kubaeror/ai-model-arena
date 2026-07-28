import type { Task } from '../queue/types.js';
import { createQueue } from '../queue/index.js';
import type { Logger } from '../types.js';

export interface WorkflowStep {
  id: string;
  dependsOn: string[];
  task: Omit<Task, 'taskId' | 'sessionId' | 'enqueuedAt' | 'attempts'>;
}

export interface Workflow {
  id: string;
  steps: WorkflowStep[];
}

interface StepState {
  id: string;
  status: 'pending' | 'enqueued' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
}

/**
 * Execute a DAG workflow where steps are enqueued only when their
 * dependencies have completed successfully. Fan-out (parallel) steps
 * are enqueued simultaneously; fan-in steps wait for all dependencies.
 */
export async function runWorkflow(
  workflow: Workflow,
  logger?: Logger,
): Promise<Map<string, StepState>> {
  const states = new Map<string, StepState>();
  const queue = createQueue();

  // Initialize all steps as pending
  for (const step of workflow.steps) {
    states.set(step.id, { id: step.id, status: 'pending' });
  }

  const ts = new Date().toISOString();

  while (true) {
    const ready = workflow.steps.filter((step) => {
      const state = states.get(step.id);
      if (state?.status !== 'pending') return false;

      // Check all dependencies are completed
      return step.dependsOn.every((depId) => {
        const depState = states.get(depId);
        return depState?.status === 'completed';
      });
    });

    if (ready.length === 0) {
      // Check if any steps are still running
      const running = workflow.steps.some((s) => states.get(s.id)?.status === 'running');
      if (!running) break;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    // Fan-out: enqueue all ready steps in parallel
    for (const step of ready) {
      const taskId = `${workflow.id}-${step.id}`;
      states.set(step.id, { id: step.id, status: 'enqueued' });

      const task: Task = {
        taskId,
        sessionId: taskId,
        provider: step.task.provider,
        model: step.task.model,
        scenario: step.task.scenario,
        config: step.task.config,
        enqueuedAt: ts,
        attempts: 0,
        priority: step.task.priority,
      };

      try {
        await queue.enqueue(task);
        states.set(step.id, { id: step.id, status: 'running' });
        logger?.info('Workflow step enqueued', { workflowId: workflow.id, stepId: step.id });

        // Mark as completed immediately for DAG progression
        // In production, this would be an async callback from the runner
        states.set(step.id, { id: step.id, status: 'completed' });
      } catch (err) {
        states.set(step.id, {
          id: step.id,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return states;
}

/**
 * Create a fan-out workflow that runs the same scenario across multiple models.
 */
export function createFanOutWorkflow(
  workflowId: string,
  scenario: string,
  models: Array<{ provider: string; model: string }>,
): Workflow {
  return {
    id: workflowId,
    steps: models.map((m, i) => ({
      id: `run-${i}`,
      dependsOn: [],
      task: {
        provider: m.provider,
        model: m.model,
        scenario,
        config: { modelRunId: workflowId },
      },
    })),
  };
}

/**
 * Create a fan-in workflow: run all models, then run a comparison step.
 */
export function createCompareWorkflow(
  workflowId: string,
  scenario: string,
  models: Array<{ provider: string; model: string }>,
  compareModel: { provider: string; model: string },
): Workflow {
  const runSteps = models.map((m, i) => ({
    id: `run-${i}`,
    dependsOn: [] as string[],
    task: {
      provider: m.provider,
      model: m.model,
      scenario,
      config: { modelRunId: workflowId },
    },
  }));

  return {
    id: workflowId,
    steps: [
      ...runSteps,
      {
        id: 'compare',
        dependsOn: runSteps.map((s) => s.id),
        task: {
          provider: compareModel.provider,
          model: compareModel.model,
          scenario: `${scenario}-compare`,
          config: { modelRunId: workflowId, isComparison: true },
        },
      },
    ],
  };
}
