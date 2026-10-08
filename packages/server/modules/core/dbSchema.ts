/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Optional } from '@speckle/shared'
import knex from '@/db/knex'
import type { BaseMetaRecord } from '@/modules/core/helpers/meta'
import type { Knex } from 'knex'
import { reduce } from 'lodash-es'

type BaseInnerSchemaConfig<T extends string, C extends string> = {
  /**
   * Table name
   */
  name: T
  /**
   * Get `knex(tableName)` QueryBuilder instance. Use the generic argument to type the results of the query.
   */
  knex: <TResult = any>(db?: Knex) => Knex.QueryBuilder<any, TResult>
  /**
   * Get names of table columns. The names can be prefixed with the table name or not, depending
   * on whether `withoutTablePrefix` was set when accessing the helper.
   */
  col: {
    [colName in C]: string
  }

  /**
   * Build a "col AS alias" definition that can be used in .select() calls and .where() clauses
   */
  colAs<A extends string>(colName: C, alias: A): Knex.Raw

  /**
   * Use in .select() calls when selecting joined tables to ensure all table's rows get collected into a single
   * array and held in a key identified by name.
   *
   * Make sure the rows of this table are grouped, otherwise this aggregation won't work
   */
  groupArray(name: string): Knex.Raw

  /**
   * All of the column names in an array
   */
  cols: string[]
}

type BaseSchemaConfig<BC extends BaseInnerSchemaConfig<any, any>> = BC & {
  /**
   * Return schema helper with custom configuration options
   */
  with: (params?: SchemaConfigParams) => BC

  /**
   * Helper with withoutTablePrefix set to true
   */
  withoutTablePrefix: BC

  /**
   * Alias to withoutTablePrefix - omits table prefixes from final strings. Useful in UPDATE
   * queries.
   */
  short: BC
}

type InnerSchemaConfig<
  T extends string,
  C extends string,
  M extends Optional<MetaSchemaConfig<any, any, any>>
> = BaseInnerSchemaConfig<T, C> & {
  /**
   * Associated meta table helper, if any
   */
  meta: M
}

export type SchemaConfig<
  T extends string,
  C extends string,
  M extends Optional<MetaSchemaConfig<any, any, any>>
> = BaseSchemaConfig<InnerSchemaConfig<T, C, M>>

type MetaInnerSchemaConfig<
  T extends string,
  C extends string,
  MK extends string
> = BaseInnerSchemaConfig<T, keyof BaseMetaRecord | C> & {
  /**
   * Get meta keys individually
   */
  metaKey: {
    [keyName in MK]: keyName
  }

  /**
   * Get all available meta keys
   */
  metaKeys: string[]

  /**
   * Column in the meta table that identifies an entity from the associated parent table.
   * E.g. In the users_meta table this column is 'user_id' - it identifies the user for which the meta value is stored
   */
  parentIdentityCol: string
}

export type MetaSchemaConfig<
  T extends string,
  C extends string,
  MK extends string
> = BaseSchemaConfig<MetaInnerSchemaConfig<T, C, MK>>

type SchemaConfigParams = {
  /**
   * Configure `col` properties to not have the table name prefixed. For the most part you want the prefix,
   * cause this helps in queries with JOINS (when multiple tables have a col with the same name), but you don't
   * want the prefix when triggering UPDATE queries, because the `SET <name> = <value>` syntax doesn't support
   * column names with table prefixes.
   */
  withoutTablePrefix?: boolean

  /**
   * Configure a custom table prefix that will be attached to column names. This will be relevant when you're
   * building subqueries or joining a table onto itself.
   */
  withCustomTablePrefix?: string

  /**
   * Will surround with quotes for putting directly in knex.raw() queries
   */
  quoted?: boolean
}

const createBaseInnerSchemaConfigBuilder =
  <T extends string, C extends string>(tableName: T, columns: C[]) =>
  (params: SchemaConfigParams = {}): BaseInnerSchemaConfig<T, C> => {
    const quoted = params.quoted || false
    const aliasedTableName = params.withCustomTablePrefix
      ? `${tableName} as ${params.withCustomTablePrefix}`
      : tableName

    const prefix = params.withoutTablePrefix
      ? null
      : params.withCustomTablePrefix || tableName

    const colName = (col: string, options?: Partial<{ addQuotes: boolean }>) => {
      const { addQuotes } = options || {}

      return addQuotes
        ? (prefix?.length ? `"${prefix}".` : '') + `"${col}"`
        : (prefix?.length ? `${prefix}.` : '') + `${col}`
    }

    return {
      name: aliasedTableName as T,
      knex: (db?: Knex) => (db || knex)(aliasedTableName),
      col: reduce(
        columns,
        (prev, curr) => {
          prev[curr] = colName(curr, { addQuotes: quoted })
          return prev
        },
        {} as Record<C, string>
      ),
      colAs: (col, alias) =>
        knex.raw(`${colName(col, { addQuotes: true })} AS "${alias}"`),
      groupArray: (name) =>
        knex.raw(
          `array_agg(row_to_json(${
            (prefix?.length ? prefix + '.' : '') + '*'
          })) as "${name}"`
        ),
      cols: columns.map((c) => colName(c, { addQuotes: quoted }))
    }
  }

/**
 * Create table schema helper
 * @param tableName
 * @param columns
 */
export function buildTableHelper<
  T extends string,
  C extends string,
  M extends Optional<MetaSchemaConfig<any, any, any>>
>(tableName: T, columns: C[], metaTable?: M): SchemaConfig<T, C, M> {
  const buildBaseConfig = createBaseInnerSchemaConfigBuilder(tableName, columns)
  const buildInnerConfig = (
    params: SchemaConfigParams = {}
  ): InnerSchemaConfig<T, C, M> => ({
    ...buildBaseConfig(params),
    meta: metaTable as M
  })

  return {
    ...buildInnerConfig(),
    with: buildInnerConfig,
    withoutTablePrefix: buildInnerConfig({ withoutTablePrefix: true }),
    short: buildInnerConfig({ withoutTablePrefix: true })
  }
}

/**
 * Create meta table schema helper
 */
export function buildMetaTableHelper<
  T extends string,
  C extends string,
  MK extends string
>(
  tableName: T,
  extraColumns: C[],
  metaKeys: MK[],
  parentIdentityCol: C
): MetaSchemaConfig<T, C, MK> {
  const baseColumns: Array<keyof BaseMetaRecord> = [
    'key',
    'value',
    'createdAt',
    'updatedAt'
  ]
  const buildBaseConfig = createBaseInnerSchemaConfigBuilder(tableName, [
    ...extraColumns,
    ...baseColumns
  ])

  const buildInnerMetaConfig = (
    params: SchemaConfigParams = {}
  ): MetaInnerSchemaConfig<T, C, MK> => ({
    ...buildBaseConfig(params),
    metaKeys,
    metaKey: reduce(
      [...metaKeys, ...baseColumns],
      (prev, curr) => {
        prev[curr] = curr
        return prev
      },
      {} as Record<keyof BaseMetaRecord | MK, keyof BaseMetaRecord | MK>
    ) as { [keyName in MK]: keyName },
    parentIdentityCol
  })

  return {
    ...buildInnerMetaConfig(),
    with: buildInnerMetaConfig,
    withoutTablePrefix: buildInnerMetaConfig({ withoutTablePrefix: true }),
    short: buildInnerMetaConfig({ withoutTablePrefix: true })
  }
}

/*
 * TABLE HELPERS
 * The generated helpers are used like this:
 *
 * Streams.name - TableName
 * Streams.col.id - Get column names
 * Streams.knex() - Get knex() instance for this specific table
 *
 * Streams.with({...}) - configure helper, e.g. disable table name being prefixed to col names:
 * Streams.with({withoutTablePrefix: true}).col.id
 *
 * Streams.withoutTablePrefix.col.id - Shorthand for accessing columns without the table prefix
 *
 * META TABLE HELPERS
 * Largely the same, but also hold extra props like `metaKeys` that store allowed meta keys
 */

export const StreamsMeta = buildMetaTableHelper(
  'streams_meta',
  ['streamId', 'key', 'value', 'createdAt', 'updatedAt'],
  ['onboardingBaseStream'],
  'streamId'
)

export const Streams = buildTableHelper(
  'streams',
  [
    'id',
    'name',
    'description',
    'clonedFrom',
    'createdAt',
    'updatedAt',
    'allowPublicComments',
    'workspaceId',
    'regionKey',
    'visibility'
  ],
  StreamsMeta
)

export const StreamAcl = buildTableHelper('stream_acl', [
  'userId',
  'resourceId',
  'role'
])

export const StreamFavorites = buildTableHelper('stream_favorites', [
  'streamId',
  'userId',
  'createdAt',
  'cursor'
])

export const UsersMetaFlags = ['presentationsFeatureNudgeDismissed'] as const

type UsersMetaFlag = (typeof UsersMetaFlags)[number]

export const isUsersMetaFlag = (key: string): key is UsersMetaFlag => {
  return UsersMetaFlags.includes(key as UsersMetaFlag)
}

export const UsersMeta = buildMetaTableHelper(
  'users_meta',
  ['userId', 'key', 'value', 'createdAt', 'updatedAt'],
  [
    ...UsersMetaFlags,
    'isOnboardingFinished',
    'onboardingStreamId',
    'activeWorkspace',
    'isProjectsActive',
    'newWorkspaceExplainerDismissed',
    'speckleConBannerDismissed',
    'intelligenceCommunityStandUpBannerDismissed',
    'speckleCon25BannerDismissed',
    'legacyProjectsExplainerCollapsed',
    // Used in tests
    'foo',
    'bar'
  ],
  'userId'
)

export const Users = buildTableHelper(
  'users',
  [
    'id',
    'suuid',
    'createdAt',
    'name',
    'bio',
    'company',
    'email',
    'verified',
    'avatar',
    'profiles',
    'passwordDigest',
    'ip'
  ],
  UsersMeta
)

export const ServerAcl = buildTableHelper('server_acl', ['userId', 'role'])

export const Comments = buildTableHelper('comments', [
  'id',
  'streamId',
  'authorId',
  'createdAt',
  'updatedAt',
  'text',
  'screenshot',
  'data',
  'archived',
  'parentComment'
])

export const CommentLinks = buildTableHelper('comment_links', [
  'commentId',
  'resourceId',
  'resourceType'
])

export const CommentViews = buildTableHelper('comment_views', [
  'commentId',
  'userId',
  'viewedAt'
])

export const ServerInvites = buildTableHelper('server_invites', [
  'id',
  'target',
  'inviterId',
  'createdAt',
  'updatedAt',
  'message',
  'resource',
  'token'
])

export const PasswordResetTokens = buildTableHelper('pwdreset_tokens', [
  'id',
  'email',
  'createdAt'
])

export const RefreshTokens = buildTableHelper('refresh_tokens', [
  'id',
  'tokenDigest',
  'appId',
  'userId',
  'createdAt',
  'lifespan'
])

export const AuthorizationCodes = buildTableHelper('authorization_codes', [
  'id',
  'appId',
  'userId',
  'challenge',
  'createdAt',
  'lifespan'
])

export const ApiTokens = buildTableHelper('api_tokens', [
  'id',
  'tokenDigest',
  'owner',
  'name',
  'lastChars',
  'revoked',
  'lifespan',
  'createdAt',
  'lastUsed'
])

export const PersonalApiTokens = buildTableHelper('personal_api_tokens', [
  'tokenId',
  'userId'
])

export const EmbedApiTokens = buildTableHelper('embed_api_tokens', [
  'tokenId',
  'projectId',
  'userId',
  'resourceIdString'
])

export const UserServerAppTokens = buildTableHelper('user_server_app_tokens', [
  'appId',
  'userId',
  'tokenId'
])

export const TokenScopes = buildTableHelper('token_scopes', ['tokenId', 'scopeName'])

export const EmailVerifications = buildTableHelper('email_verifications', [
  'id',
  'email',
  'createdAt',
  'used',
  'code'
])

export const ServerAccessRequests = buildTableHelper('server_access_requests', [
  'id',
  'requesterId',
  'resourceType',
  'resourceId',
  'createdAt',
  'updatedAt'
])

export const Activity = buildTableHelper('activity', [
  'id',
  'contextResourceId',
  'contextResourceType',
  'eventType',
  'userId',
  'payload',
  'createdAt'
])

export const StreamActivity = buildTableHelper('stream_activity', [
  'streamId',
  'time',
  'resourceType',
  'resourceId',
  'actionType',
  'userId',
  'info',
  'message'
])

export const UserNotificationPreferences = buildTableHelper(
  'user_notification_preferences',
  ['userId', 'preferences']
)

export const Commits = buildTableHelper('commits', [
  'id',
  'referencedObject',
  'author',
  'message',
  'createdAt',
  'sourceApplication',
  'totalChildrenCount',
  'parents'
])

export const StreamCommits = buildTableHelper('stream_commits', [
  'streamId',
  'commitId'
])

export const BranchCommits = buildTableHelper('branch_commits', [
  'branchId',
  'commitId'
])

export const Branches = buildTableHelper('branches', [
  'id',
  'streamId',
  'authorId',
  'name',
  'description',
  'createdAt',
  'updatedAt'
])

export const ScheduledTasks = buildTableHelper('scheduled_tasks', [
  'taskName',
  'lockExpiresAt'
])

export const Objects = buildTableHelper('objects', [
  'id',
  'speckleType',
  'totalChildrenCount',
  'totalChildrenCountByDepth',
  'createdAt',
  'data',
  'streamId'
])

export const FileUploads = buildTableHelper('file_uploads', [
  'id',
  'streamId',
  'branchName',
  'userId',
  'modelId',
  'fileName',
  'fileType',
  'fileSize',
  'uploadComplete',
  'uploadDate',
  'convertedStatus',
  'convertedLastUpdate',
  'convertedMessage',
  'convertedCommitId',
  'performanceData',
  'discipline',
  'suitabilityStatus',
  'revision'
])

export const Facilities = buildTableHelper('facilities', [
  'id',
  'projectId',
  'name',
  'tagSourceProperty',
  'namingConfig',
  'energyTariffPerKwh',
  'createdAt',
  'updatedAt'
])

export const Floors = buildTableHelper('floors', [
  'id',
  'projectId',
  'facilityId',
  'name',
  'elevationZ',
  'createdAt',
  'updatedAt'
])

export const Spaces = buildTableHelper('spaces', [
  'id',
  'projectId',
  'facilityId',
  'floorId',
  'zoneId',
  'name',
  'elevationZ',
  'speckleObjectId',
  'createdAt',
  'updatedAt'
])

export const Zones = buildTableHelper('zones', [
  'id',
  'projectId',
  'facilityId',
  'floorId',
  'name',
  'createdAt',
  'updatedAt'
])

export const AssetTypes = buildTableHelper('asset_types', [
  'id',
  'name',
  'category',
  'manufacturer',
  'modelNumber',
  'nature',
  'description',
  'expectedLifeYears',
  'extendedAttributes',
  'ifcClass',
  'isControllableDevice',
  'createdBy',
  'createdAt',
  'updatedAt'
])

export const AssetSystems = buildTableHelper('asset_systems', [
  'id',
  'projectId',
  'facilityId',
  'name',
  'description',
  'createdAt',
  'updatedAt'
])

export const AssetClasses = buildTableHelper('asset_classes', [
  'id',
  'projectId',
  'facilityId',
  'parentId',
  'code',
  'name',
  'level',
  'ifcClasses',
  'createdAt',
  'updatedAt'
])

export const Assets = buildTableHelper('assets', [
  'id',
  'projectId',
  'facilityId',
  'tagNumber',
  'identityCode',
  'name',
  'assetTypeId',
  'assetClassId',
  'spaceId',
  'state',
  'tenure',
  'currentObjectId',
  'currentVersionId',
  'installDate',
  'warrantyStartDate',
  'serialNumber',
  'barCode',
  'extendedAttributes',
  'createdAt',
  'updatedAt'
])

export const AssetSystemMembers = buildTableHelper('asset_system_members', [
  'assetId',
  'systemId'
])

export const DeviceStates = buildTableHelper('device_states', [
  'assetId',
  'projectId',
  'powerState',
  'setpoint',
  'currentTemperature',
  'ambientTemperature',
  'nominalPowerKw',
  'cumulativeKwh',
  'cumulativeCost',
  'compressorDuty',
  'currentA',
  'degradationRate',
  'startupCurrentDecay',
  'noiseAmplification',
  'poweredOnAt',
  'updatedAt'
])

export const DeviceStateSegments = buildTableHelper('device_state_segments', [
  'id',
  'assetId',
  'projectId',
  'startsAt',
  'powerState',
  'setpoint',
  'ambientTemperature',
  'nominalPowerKw',
  'degradationRate',
  'startupCurrentDecay',
  'noiseAmplification',
  'tariffPerKwh',
  'temperatureAtStart',
  'cumulativeKwhAtStart',
  'cumulativeCostAtStart',
  'poweredOnAt',
  'createdAt'
])

export const DeviceCommands = buildTableHelper('device_commands', [
  'id',
  'assetId',
  'projectId',
  'commandType',
  'value',
  'issuedBy',
  'issuedAt'
])

export const TelemetryReadings = buildTableHelper('telemetry_readings', [
  'id',
  'assetId',
  'projectId',
  'ts',
  'temperature',
  'powerState',
  'compressorDuty',
  'currentA'
])

export const EnergyReadings = buildTableHelper('energy_readings', [
  'id',
  'assetId',
  'projectId',
  'ts',
  'powerKw',
  'energyKwhInterval',
  'cumulativeKwh',
  'costInterval',
  'cumulativeCost'
])

export const MaintenanceOrders = buildTableHelper('maintenance_orders', [
  'id',
  'projectId',
  'facilityId',
  'assetId',
  'title',
  'description',
  'type',
  'status',
  'priority',
  'reportedBy',
  'assignedTo',
  'dueDate',
  'completedAt',
  'createdAt',
  'updatedAt'
])

export const FacilityDocuments = buildTableHelper('facility_documents', [
  'id',
  'projectId',
  'facilityId',
  'assetId',
  'spaceId',
  'title',
  'category',
  'description',
  'blobId',
  'fileName',
  'fileSize',
  'status',
  'revision',
  'uploadedBy',
  'createdAt',
  'updatedAt'
])

export const Sensors = buildTableHelper('sensors', [
  'id',
  'projectId',
  'facilityId',
  'assetId',
  'spaceId',
  'name',
  'type',
  'unit',
  'manufacturer',
  'model',
  'serialNumber',
  'status',
  'apiKeyHash',
  'lastReadingValue',
  'lastReadingAt',
  'createdAt',
  'updatedAt'
])

export const SensorReadings = buildTableHelper('sensor_readings', [
  'id',
  'sensorId',
  'projectId',
  'ts',
  'value'
])

export const DeviceHealthSignals = buildTableHelper('device_health_signals', [
  'id',
  'assetId',
  'projectId',
  'metric',
  'trend',
  'severity',
  'zScore',
  'since',
  'updatedAt'
])

export const MaintenanceReports = buildTableHelper('maintenance_reports', [
  'id',
  'projectId',
  'facilityId',
  'assetId',
  'summary',
  'recommendation',
  'severity',
  'signalsSnapshot',
  'generatedAt',
  'generatedBy'
])

// ---- BIM coordination (facilities module) ---------------------------------

export const CoordRequirementSources = buildTableHelper('coord_requirement_sources', [
  'id',
  'projectId',
  'kind',
  'title',
  'document',
  'revision',
  'clause',
  'parentId',
  'createdAt',
  'updatedAt'
])

export const CoordMilestones = buildTableHelper('coord_milestones', [
  'id',
  'projectId',
  'name',
  'dueDate',
  'discipline',
  'createdAt',
  'updatedAt'
])

export const CoordRequirements = buildTableHelper('coord_requirements', [
  'id',
  'projectId',
  'sourceId',
  'milestoneId',
  'code',
  'title',
  'discipline',
  'purpose',
  'targetPct',
  'spec',
  'createdAt',
  'updatedAt'
])

export const CoordRuleSets = buildTableHelper('coord_rule_sets', [
  'id',
  'projectId',
  'name',
  'format',
  'milestoneId',
  'purpose',
  'generatedFrom',
  'createdBy',
  'createdAt',
  'updatedAt'
])

export const CoordRuleSetVersions = buildTableHelper('coord_rule_set_versions', [
  'id',
  'projectId',
  'ruleSetId',
  'version',
  'status',
  'publishedAt',
  'publishedBy',
  'idsXml',
  'createdAt',
  'updatedAt'
])

export const CoordRules = buildTableHelper('coord_rules', [
  'id',
  'projectId',
  'ruleSetVersionId',
  'code',
  'name',
  'requirementId',
  'severity',
  'weight',
  'definition',
  'position',
  'createdAt',
  'updatedAt'
])

export const CoordRuleSetBindings = buildTableHelper('coord_rule_set_bindings', [
  'projectId',
  'ruleSetId',
  'modelId',
  'autoRun',
  'unkeyedBlockPct',
  'createdAt',
  'updatedAt'
])

export const CoordCheckRuns = buildTableHelper('coord_check_runs', [
  'id',
  'projectId',
  'ruleSetId',
  'ruleSetVersionId',
  'modelId',
  'versionId',
  'trigger',
  'status',
  'attempt',
  'createdBy',
  'unkeyedBlockPct',
  'queuedAt',
  'startedAt',
  'finishedAt',
  'error',
  'elementCount',
  'applicableCount',
  'passCount',
  'warnCount',
  'failCount',
  'naCount',
  'unkeyedCount',
  'adherence',
  'unkeyedSample',
  'engine',
  'ifcObjectKey'
])

export const CoordCheckResults = buildTableHelper('coord_check_results', [
  'runId',
  'ruleId',
  'elementKey',
  'speckleObjectId',
  'status',
  'actualValue',
  'message'
])

export const CoordElementScores = buildTableHelper('coord_element_scores', [
  'runId',
  'elementKey',
  'speckleObjectId',
  'status',
  'score'
])

export const CoordRequirementStats = buildTableHelper('coord_requirement_stats', [
  'runId',
  'requirementId',
  'applicableCount',
  'passCount'
])

export const CoordRuleStats = buildTableHelper('coord_rule_stats', [
  'runId',
  'ruleId',
  'applicableCount',
  'passCount',
  'warnCount',
  'failCount'
])

export const CoordAuditEvents = buildTableHelper('coord_audit_events', [
  'id',
  'projectId',
  'actorId',
  'action',
  'entityType',
  'entityId',
  'data',
  'createdAt'
])

export const CoordClashTests = buildTableHelper('coord_clash_tests', [
  'id',
  'projectId',
  'name',
  'type',
  'toleranceMm',
  'clearanceMm',
  'groupA',
  'groupB',
  'ignore',
  'autoRun',
  'createdBy',
  'createdAt',
  'updatedAt'
])

export const CoordClashRuns = buildTableHelper('coord_clash_runs', [
  'id',
  'projectId',
  'testId',
  'modelIdA',
  'versionIdA',
  'objectKeyA',
  'modelIdB',
  'versionIdB',
  'objectKeyB',
  'trigger',
  'status',
  'attempt',
  'createdBy',
  'settings',
  'queuedAt',
  'startedAt',
  'finishedAt',
  'error',
  'countA',
  'countB',
  'rawCount',
  'ignoredCount',
  'clashCount',
  'geometrySeconds',
  'peakRssMb'
])

export const CoordClashRunElements = buildTableHelper('coord_clash_run_elements', [
  'runId',
  'side',
  'elementKey',
  'speckleObjectId',
  'plannedOpening'
])

export const CoordClashRaw = buildTableHelper('coord_clash_raw', [
  'runId',
  'keyA',
  'keyB',
  'distanceMm',
  'point',
  'clashType',
  'relation'
])

export const CoordClashes = buildTableHelper('coord_clashes', [
  'id',
  'projectId',
  'runId',
  'testId',
  'fingerprint',
  'keyA',
  'keyB',
  'speckleObjectIdA',
  'speckleObjectIdB',
  'distanceMm',
  'point',
  'clashType',
  'status',
  'assignee',
  'comment',
  'createdAt',
  'updatedAt'
])

export const CoordNamingCodes = buildTableHelper('coord_naming_codes', [
  'projectId',
  'field',
  'code',
  'description',
  'position'
])

export const CoordDeliverables = buildTableHelper('coord_deliverables', [
  'id',
  'projectId',
  'containerName',
  'title',
  'kind',
  'project',
  'originator',
  'volume',
  'level',
  'type',
  'role',
  'number',
  'milestoneId',
  'responsibleUserId',
  'modelId',
  'dueDate',
  'status',
  'notes',
  'createdBy',
  'createdAt',
  'updatedAt'
])

export const CoordDeliverableDependencies = buildTableHelper(
  'coord_deliverable_dependencies',
  ['deliverableId', 'dependsOnId']
)

export const CoordDeliverableRequirements = buildTableHelper(
  'coord_deliverable_requirements',
  ['deliverableId', 'requirementId']
)

export const CoordPropertyIndex = buildTableHelper('coord_property_index', [
  'versionId',
  'projectId',
  'modelId',
  'elementCount',
  'truncated',
  'paths',
  'ifcTypes',
  'createdAt'
])

export const CoordSearchSets = buildTableHelper('coord_search_sets', [
  'id',
  'projectId',
  'name',
  'description',
  'modelId',
  'where',
  'createdBy',
  'createdAt',
  'updatedAt'
])

export const CoordCdeConfigs = buildTableHelper('coord_cde_configs', [
  'projectId',
  'config',
  'updatedBy',
  'updatedAt'
])

export const CoordProjectApprovers = buildTableHelper('coord_project_approvers', [
  'projectId',
  'userId',
  'createdBy',
  'createdAt'
])

export const CoordVersionStates = buildTableHelper('coord_version_states', [
  'id',
  'projectId',
  'modelId',
  'versionId',
  'documentRevisionId',
  'deliverableId',
  'stage',
  'stateCode',
  'stateLabel',
  'suitability',
  'revision',
  'action',
  'kind',
  'comment',
  'changedBy',
  'changedAt'
])

export const CoordDocumentRevisions = buildTableHelper('coord_document_revisions', [
  'id',
  'projectId',
  'deliverableId',
  'blobId',
  'fileName',
  'fileSize',
  'contentType',
  'extension',
  'sha256',
  'createdBy',
  'createdAt'
])

export const ServerAppsScopes = buildTableHelper('server_apps_scopes', [
  'appId',
  'scopeName'
])

export const ServerApps = buildTableHelper('server_apps', [
  'id',
  'secret',
  'name',
  'description',
  'termsAndConditionsLink',
  'logo',
  'public',
  'trustByDefault',
  'authorId',
  'createdAt',
  'redirectUrl'
])

export const Scopes = buildTableHelper('scopes', ['name', 'description', 'public'])

export const TokenResourceAccess = buildTableHelper('token_resource_access', [
  'tokenId',
  'resourceType',
  'resourceId'
])

export const AutomationFunctionRuns = buildTableHelper('automation_function_runs', [
  'id',
  'runId',
  'functionReleaseId',
  'functionId',
  'elapsed',
  'status',
  'contextView',
  'statusMessage',
  'results',
  'createdAt',
  'updatedAt'
])

export const AutomationRevisionFunctions = buildTableHelper(
  'automation_revision_functions',
  ['automationRevisionId', 'functionReleaseId', 'functionInputs', 'functionId']
)

export const AutomationRevisions = buildTableHelper('automation_revisions', [
  'id',
  'automationId',
  'active',
  'createdAt',
  'userId',
  'publicKey'
])

export const AutomationTokens = buildTableHelper('automation_tokens', [
  'automationId',
  'automateToken'
])

export const AutomationRuns = buildTableHelper('automation_runs', [
  'id',
  'automationRevisionId',
  'createdAt',
  'updatedAt',
  'status',
  'executionEngineRunId'
])

export const AutomationTriggers = buildTableHelper('automation_triggers', [
  'automationRevisionId',
  'triggerType',
  'triggeringId'
])

export const AutomationRunTriggers = buildTableHelper('automation_run_triggers', [
  'automationRunId',
  'triggerType',
  'triggeringId'
])

export const Automations = buildTableHelper('automations', [
  'id',
  'name',
  'projectId',
  'enabled',
  'createdAt',
  'updatedAt',
  'userId',
  'executionEngineAutomationId',
  'isTestAutomation',
  'isDeleted'
])

export const GendoAIRenders = buildTableHelper('gendo_ai_renders', [
  'id',
  'userId',
  'projectId',
  'modelId',
  'versionId',
  'createdAt',
  'updatedAt',
  'gendoGenerationId',
  'status',
  'prompt',
  'camera',
  'baseImage',
  'responseImage'
])

export const UserEmails = buildTableHelper('user_emails', [
  'id',
  'email',
  'primary',
  'verified',
  'userId',
  'createdAt',
  'updatedAt'
])

export const UserRoles = buildTableHelper('user_roles', [
  'name',
  'description',
  'resourceTarget',
  'aclTableName',
  'weight',
  'public'
])

export { knex }
