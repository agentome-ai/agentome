import { sql } from '@agentome/db';

/**
 * The repository a task's runs work in: its own, else its project's main one as it is now. A
 * task in a project keeps none of its own unless a person gave it one, so a repository added to
 * the project later reaches its tasks. Spelled out: inside the subquery Drizzle
 * would write the column without its table.
 */
export const taskRepository = sql<
  string | null
>`coalesce("tasks"."repository", (select p.repositories[1] from projects p where p.id = "tasks"."project_id"))`;
