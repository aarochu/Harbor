/**
 * Render REST API types.
 *
 * Modelled on https://api.render.com/v1. Only the surface Harbor actually uses
 * is typed — a partial model that is accurate beats a complete one that drifts.
 *
 * Fields are optional where the API says they can be absent, so a missing value
 * shows up as a type error at the use site rather than as `undefined` reaching
 * a deploy decision.
 */

export type ServiceType =
  | 'web_service'
  | 'private_service'
  | 'background_worker'
  | 'cron_job'
  | 'static_site'

/** Native runtimes Harbor deploys, plus docker. */
export type Runtime = 'node' | 'python' | 'docker' | 'ruby' | 'go' | 'elixir' | 'rust' | 'image'

export type Region = 'oregon' | 'virginia' | 'ohio' | 'frankfurt' | 'singapore'

/**
 * Deploy lifecycle.
 *
 * Eleven states, and the split that matters is terminal vs in-progress: polling
 * has to stop on the first group and keep going on the second. Treating an
 * unrecognised state as terminal would end a poll early and report a deploy as
 * finished while it is still building.
 */
export type DeployStatus =
  | 'created'
  | 'queued'
  | 'build_in_progress'
  | 'update_in_progress'
  | 'pre_deploy_in_progress'
  | 'live'
  | 'build_failed'
  | 'update_failed'
  | 'pre_deploy_failed'
  | 'canceled'
  | 'deactivated'

export const TERMINAL_DEPLOY_STATUSES: readonly DeployStatus[] = [
  'live',
  'build_failed',
  'update_failed',
  'pre_deploy_failed',
  'canceled',
  'deactivated',
]

/** Only `live` is success. Everything else terminal is a failure to diagnose. */
export const SUCCESSFUL_DEPLOY_STATUS: DeployStatus = 'live'

export function isTerminalDeploy(status: DeployStatus): boolean {
  return TERMINAL_DEPLOY_STATUSES.includes(status)
}

export interface DeployCommit {
  id?: string
  message?: string
  createdAt?: string
}

export interface Deploy {
  id: string
  status: DeployStatus
  commit?: DeployCommit
  trigger?: string
  /** ISO-8601, as returned by the API. */
  createdAt?: string
  startedAt?: string
  finishedAt?: string
  updatedAt?: string
}

export interface EnvVarInput {
  key: string
  value: string
}

export interface ServiceDetails {
  env?: Runtime
  runtime?: Runtime
  plan?: string
  region?: Region
  numInstances?: number
  healthCheckPath?: string
  url?: string
  envSpecificDetails?: {
    buildCommand?: string
    startCommand?: string
  }
}

export interface Service {
  id: string
  name: string
  type: ServiceType
  repo?: string
  branch?: string
  autoDeploy?: string
  suspended?: string
  serviceDetails?: ServiceDetails
  createdAt?: string
  updatedAt?: string
}

export interface CreateServiceResult {
  service: Service
  /** Render starts a deploy on creation and hands back its id. */
  deployId?: string
}

export interface CreateWebServiceInput {
  name: string
  ownerId: string
  repo: string
  branch?: string
  runtime: Runtime
  buildCommand: string
  startCommand: string
  plan?: string
  region?: Region
  healthCheckPath?: string
  envVars?: EnvVarInput[]
  /**
   * Render's default is "yes". Harbor sets "no": the agent decides when to
   * deploy, and a push-triggered deploy racing a Harbor-triggered one makes
   * the activity stream describe a build that is not the one being watched.
   */
  autoDeploy?: 'yes' | 'no'
}

export type PostgresStatus =
  | 'creating'
  | 'available'
  | 'unavailable'
  | 'unknown'
  | 'config_restart'
  | 'suspended'
  | 'maintenance_in_progress'

export interface PostgresInstance {
  id: string
  name: string
  databaseName?: string
  databaseUser?: string
  status?: PostgresStatus
  plan?: string
  region?: Region
  version?: string
  dashboardUrl?: string
  createdAt?: string
}

export interface CreatePostgresInput {
  name: string
  ownerId: string
  /** Render's free tier expires after a fixed window; see SOW §11. */
  plan: string
  version?: string
  region?: Region
  databaseName?: string
  databaseUser?: string
}

/**
 * Connection details for a provisioned database.
 *
 * Every field here is a credential. The whole object is registered for
 * redaction the moment it arrives, so it can be passed to a
 * set-environment-variable call without any part of it reaching a log line, an
 * event, or model context.
 */
export interface PostgresConnectionInfo {
  internalConnectionString?: string
  externalConnectionString?: string
  psqlCommand?: string
}

/**
 * One line of service output.
 *
 * Render separates build output from application output, and the distinction
 * matters for diagnosis: a dependency that fails to install shows up in
 * `build`, whereas one that installs and then fails to import shows up in
 * `app`. Reading only the build log would miss the second entirely.
 */
export interface LogEntry {
  timestamp?: string
  message: string
}

export type LogType = 'app' | 'build' | 'request'

/** Cursor-paginated list envelope used across the API. */
export interface Paginated<T> {
  items: T[]
  cursor?: string
}
