-- Session-task memory schema. Existing installations require explicit initialization.

CREATE TABLE IF NOT EXISTS acceptance_results (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  step_id TEXT REFERENCES task_steps(step_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  criterion_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','passed','failed')),
  summary TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  adapter_instance_id TEXT NOT NULL,
  connection_epoch INTEGER NOT NULL,
  external_request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  risk_summary TEXT NOT NULL,
  approval_state TEXT NOT NULL CHECK (approval_state IN ('pending','approved','denied','expired','invalidated')),
  requested_at TEXT NOT NULL,
  expires_at TEXT,
  decided_at TEXT,
  decided_by TEXT,
  decision_evidence_id TEXT REFERENCES evidence(evidence_id),
  UNIQUE(adapter_instance_id, connection_epoch, external_request_id)
) STRICT;

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  execution_id TEXT REFERENCES executions(execution_id),
  kind TEXT NOT NULL,
  path_or_uri TEXT NOT NULL,
  content_hash TEXT,
  size INTEGER,
  created_at TEXT NOT NULL,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  verification_evidence_id TEXT REFERENCES evidence(evidence_id),
  retention_class TEXT NOT NULL DEFAULT 'normal'
) STRICT;

CREATE TABLE IF NOT EXISTS attention_items (
  attention_id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(task_id),
  execution_id TEXT REFERENCES executions(execution_id),
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','acknowledged','resolved')),
  summary TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS background_job_status (
  job_name TEXT PRIMARY KEY,
  status_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  correlation_id TEXT,
  causation_id TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  source_record_id TEXT NOT NULL REFERENCES source_records(source_record_id),
  session_ref_id TEXT REFERENCES session_refs(session_ref_id),
  task_id TEXT REFERENCES tasks(task_id),
  source_type TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_external_id TEXT,
  source_uri TEXT NOT NULL,
  source_offset_json TEXT NOT NULL,
  occurred_at TEXT,
  ingested_at TEXT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES source_blobs(content_hash),
  mime_type TEXT NOT NULL,
  author_role TEXT,
  trust_level TEXT NOT NULL,
  supersedes_evidence_id TEXT REFERENCES evidence(evidence_id),
  corrects_evidence_id TEXT REFERENCES evidence(evidence_id),
  redaction_state TEXT NOT NULL DEFAULT 'none',
  memory_class TEXT NOT NULL DEFAULT 'recent' CHECK(memory_class IN ('temporary','recent','durable','pending')),
  memory_note TEXT NOT NULL DEFAULT '',
  memory_tags_json TEXT NOT NULL DEFAULT '[]',
  execution_id TEXT REFERENCES executions(execution_id),
  UNIQUE(source_record_id, source_type)
) STRICT;

CREATE TABLE IF NOT EXISTS execution_sessions (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  session_ref_id TEXT NOT NULL REFERENCES session_refs(session_ref_id),
  role TEXT NOT NULL CHECK (role IN ('interaction','executor','observer','fork_source')),
  attached_at TEXT NOT NULL,
  detached_at TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  evidence_id TEXT REFERENCES evidence(evidence_id),
  PRIMARY KEY(execution_id, session_ref_id, role)
) STRICT;

CREATE TABLE IF NOT EXISTS execution_usage (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  source_key TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  usage_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(execution_id,source_key)
) STRICT;

CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_no INTEGER NOT NULL,
  executor_kind TEXT NOT NULL CHECK (executor_kind IN ('codex','dsh_subagent','internal')),
  execution_state TEXT NOT NULL CHECK (execution_state IN ('planned','dispatch_pending','dispatch_unknown','reconciling','running','waiting_approval','waiting_user','succeeded','failed','cancelled','interrupted')),
  idempotency_key TEXT NOT NULL UNIQUE,
  route_decision_id TEXT REFERENCES route_decisions(route_decision_id),
  workspace_location_id TEXT REFERENCES project_locations(location_id),
  workspace_baseline_id TEXT REFERENCES workspace_baselines(baseline_id),
  requested_capabilities_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT,
  heartbeat_at TEXT,
  finished_at TEXT,
  result_class TEXT,
  failure_code TEXT,
  failure_detail TEXT,
  predecessor_execution_id TEXT REFERENCES executions(execution_id), worker_policy_json TEXT NOT NULL DEFAULT '{}', step_id TEXT REFERENCES task_steps(step_id),
  UNIQUE(task_id, attempt_no)
) STRICT;

CREATE TABLE IF NOT EXISTS feature_flags (
  flag_name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS import_cursors (
  importer_id TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  cursor_json TEXT NOT NULL,
  last_attempted_at TEXT NOT NULL,
  last_successful_at TEXT,
  warning_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(importer_id, source_uri)
) STRICT;

CREATE TABLE IF NOT EXISTS inbox (
  inbox_id TEXT PRIMARY KEY,
  adapter_instance_id TEXT NOT NULL,
  connection_epoch INTEGER NOT NULL,
  external_event_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  process_error TEXT
, retry_attempts INTEGER NOT NULL DEFAULT 0 CHECK(retry_attempts >= 0), last_attempt_at TEXT) STRICT;

CREATE TABLE IF NOT EXISTS memory_entities (
  entity_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL UNIQUE,
  canonical_name TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  tags_json TEXT NOT NULL DEFAULT '[]',
  entity_state TEXT NOT NULL CHECK(entity_state IN ('candidate','user-stated','confirmed')),
  recorded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memory_entity_sources (
  entity_id TEXT NOT NULL REFERENCES memory_entities(entity_id),
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  quote TEXT NOT NULL,
  PRIMARY KEY(entity_id,evidence_id)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_aliases (
  entity_id TEXT NOT NULL REFERENCES memory_entities(entity_id),
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  evidence_id TEXT REFERENCES evidence(evidence_id),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(entity_id, normalized_alias)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_records (
  memory_id TEXT PRIMARY KEY,
  memory_kind TEXT NOT NULL CHECK(memory_kind IN ('fact','reflection','decision','summary')),
  entity_id TEXT REFERENCES memory_entities(entity_id),
  predicate TEXT,
  object_json TEXT,
  content TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  memory_state TEXT NOT NULL CHECK(memory_state IN ('candidate','user-stated','confirmed','superseded','retracted')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  valid_from TEXT,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK(created_by IN ('model','user','host')),
  supersedes_memory_id TEXT REFERENCES memory_records(memory_id)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_sources (
  memory_id TEXT NOT NULL REFERENCES memory_records(memory_id),
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  stance TEXT NOT NULL CHECK(stance IN ('supports','refutes')),
  quote TEXT,
  PRIMARY KEY(memory_id, evidence_id, stance)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_edges (
  edge_id TEXT PRIMARY KEY,
  from_kind TEXT NOT NULL CHECK(from_kind IN ('entity','memory','experience','task')),
  from_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  to_kind TEXT NOT NULL CHECK(to_kind IN ('entity','memory','experience','task')),
  to_id TEXT NOT NULL,
  evidence_id TEXT REFERENCES evidence(evidence_id),
  recorded_at TEXT NOT NULL,
  UNIQUE(from_kind,from_id,relation,to_kind,to_id)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_extraction_jobs (
  evidence_id TEXT PRIMARY KEY REFERENCES evidence(evidence_id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','error')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED,
  entity_id UNINDEXED,
  memory_kind UNINDEXED,
  memory_state UNINDEXED,
  text
);

CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  resource_key TEXT NOT NULL,
  workspace_location_id TEXT REFERENCES project_locations(location_id),
  execution_id TEXT REFERENCES executions(execution_id),
  owner_instance_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('read','write')),
  lease_state TEXT NOT NULL CHECK (lease_state IN ('requested','active','recovery_hold','released','expired','revoked')),
  fencing_token INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT,
  UNIQUE(resource_key, fencing_token)
) STRICT;

CREATE TABLE IF NOT EXISTS outbox (
  outbox_id TEXT PRIMARY KEY,
  execution_id TEXT REFERENCES executions(execution_id),
  method TEXT NOT NULL,
  params_json TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  intent_key TEXT NOT NULL UNIQUE,
  outbox_state TEXT NOT NULL CHECK (outbox_state IN ('pending','sending','acknowledged','uncertain','failed','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  sent_at TEXT,
  acknowledged_at TEXT,
  last_error TEXT,
  external_result_json TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS project_aliases (
  identity_kind TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  PRIMARY KEY(identity_kind,identity_value)
) STRICT;

CREATE TABLE IF NOT EXISTS project_locations (
  location_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  canonical_path TEXT NOT NULL UNIQUE,
  git_common_dir TEXT,
  worktree_id TEXT,
  writable INTEGER NOT NULL DEFAULT 1 CHECK (writable IN (0,1)),
  observed_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  identity_kind TEXT NOT NULL DEFAULT 'path',
  identity_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(identity_kind, identity_value)
) STRICT;

CREATE TABLE IF NOT EXISTS route_decisions (
  route_decision_id TEXT PRIMARY KEY,
  trigger_id TEXT REFERENCES triggers(trigger_id),
  task_id TEXT REFERENCES tasks(task_id),
  semantic_action TEXT NOT NULL CHECK (semantic_action IN ('resume_task','fork_task','new_task','read_only')),
  delivery_action TEXT NOT NULL CHECK (delivery_action IN ('start_thread','resume_thread','fork_thread','start_turn','steer_turn','queue_turn','interrupt_turn','wait','none')),
  candidate_snapshot_json TEXT NOT NULL,
  authorized_target_session_ref_id TEXT REFERENCES session_refs(session_ref_id),
  reason_codes_json TEXT NOT NULL,
  input_snapshot_hash TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  decider TEXT NOT NULL,
  explanation TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS route_feedback (
  feedback_id TEXT PRIMARY KEY,
  route_decision_id TEXT NOT NULL REFERENCES route_decisions(route_decision_id),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','corrected','rejected')),
  correction_json TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS runtime_settings (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS session_refs (
  session_ref_id TEXT PRIMARY KEY,
  system TEXT NOT NULL CHECK (system IN ('dsh','codex')),
  external_id TEXT NOT NULL,
  root_external_id TEXT,
  parent_session_ref_id TEXT REFERENCES session_refs(session_ref_id),
  forked_from_session_ref_id TEXT REFERENCES session_refs(session_ref_id),
  source_kind TEXT,
  cwd TEXT,
  workspace_roots_json TEXT NOT NULL DEFAULT '[]',
  durability TEXT NOT NULL DEFAULT 'unknown' CHECK (durability IN ('durable','ephemeral','unknown')),
  native_status TEXT,
  observed_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  provenance_evidence_id TEXT,
  UNIQUE(system, external_id)
) STRICT;

CREATE TABLE IF NOT EXISTS source_blobs (
  content_hash TEXT PRIMARY KEY,
  byte_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  content BLOB,
  compressed BLOB,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS source_records (
  source_record_id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  external_id TEXT,
  source_uri TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  occurred_at TEXT,
  observed_at TEXT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES source_blobs(content_hash),
  normalized_payload_json TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  UNIQUE(source_system, source_kind, source_uri, source_locator, source_identity)
) STRICT;

CREATE TABLE IF NOT EXISTS task_sessions (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  session_ref_id TEXT NOT NULL REFERENCES session_refs(session_ref_id),
  relation TEXT NOT NULL DEFAULT 'inferred',
  confidence REAL NOT NULL DEFAULT 0.5,
  attached_at TEXT NOT NULL,
  evidence_id TEXT,
  PRIMARY KEY(task_id, session_ref_id)
) STRICT;

CREATE TABLE IF NOT EXISTS task_steps (
  step_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  objective TEXT NOT NULL,
  step_state TEXT NOT NULL CHECK(step_state IN ('open','active','waiting','completed','cancelled')),
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, ordinal)
) STRICT;

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(project_id),
  parent_task_id TEXT REFERENCES tasks(task_id),
  source_key TEXT UNIQUE,
  objective TEXT NOT NULL,
  task_state TEXT NOT NULL CHECK (task_state IN ('candidate','open','active','waiting','completed','cancelled','merged')),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
, acceptance_json TEXT NOT NULL DEFAULT '[]') STRICT;

CREATE TABLE IF NOT EXISTS triggers (
  trigger_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_session_ref_id TEXT REFERENCES session_refs(session_ref_id),
  source_message_id TEXT,
  received_at TEXT NOT NULL,
  content_hash TEXT,
  raw_evidence_id TEXT REFERENCES evidence(evidence_id),
  dedupe_key TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE IF NOT EXISTS workspace_baselines (
  baseline_id TEXT PRIMARY KEY,
  workspace_location_id TEXT NOT NULL REFERENCES project_locations(location_id),
  captured_at TEXT NOT NULL,
  git_head TEXT,
  git_index_tree TEXT,
  status_porcelain TEXT NOT NULL,
  dirty_paths_json TEXT NOT NULL,
  path_hashes_json TEXT NOT NULL,
  capture_complete INTEGER NOT NULL CHECK (capture_complete IN (0,1)),
  evidence_id TEXT REFERENCES evidence(evidence_id)
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
  evidence_id UNINDEXED,
  task_id UNINDEXED,
  source_system UNINDEXED,
  source_external_id UNINDEXED,
  text,
  tokenize='unicode61'
);

CREATE INDEX IF NOT EXISTS acceptance_scope ON acceptance_results(task_id,step_id,criterion_id,sequence DESC);

CREATE INDEX IF NOT EXISTS attention_open ON attention_items(state, severity, created_at);

CREATE INDEX IF NOT EXISTS event_aggregate ON events(aggregate_type, aggregate_id, occurred_at);

CREATE INDEX IF NOT EXISTS evidence_content_hash ON evidence(content_hash);

CREATE INDEX IF NOT EXISTS evidence_corrects ON evidence(corrects_evidence_id);

CREATE INDEX IF NOT EXISTS evidence_execution_id ON evidence(execution_id);

CREATE INDEX IF NOT EXISTS evidence_memory_class ON evidence(memory_class, occurred_at DESC);

CREATE INDEX IF NOT EXISTS evidence_session_ref ON evidence(session_ref_id);

CREATE INDEX IF NOT EXISTS evidence_source_record ON evidence(source_record_id);

CREATE INDEX IF NOT EXISTS evidence_supersedes ON evidence(supersedes_evidence_id);

CREATE INDEX IF NOT EXISTS evidence_task_time ON evidence(task_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS memory_entities_type_name ON memory_entities(entity_type,canonical_name);
CREATE INDEX IF NOT EXISTS memory_aliases_lookup ON memory_aliases(normalized_alias);
CREATE INDEX IF NOT EXISTS memory_entity_sources_evidence ON memory_entity_sources(evidence_id,entity_id);
CREATE INDEX IF NOT EXISTS memory_records_entity_state ON memory_records(entity_id,memory_state,recorded_at DESC);
CREATE INDEX IF NOT EXISTS memory_records_kind_state ON memory_records(memory_kind,memory_state,recorded_at DESC);
CREATE INDEX IF NOT EXISTS memory_sources_evidence ON memory_sources(evidence_id,memory_id);
CREATE INDEX IF NOT EXISTS memory_edges_from ON memory_edges(from_kind,from_id,relation);
CREATE INDEX IF NOT EXISTS memory_edges_to ON memory_edges(to_kind,to_id,relation);
CREATE INDEX IF NOT EXISTS memory_extraction_pending ON memory_extraction_jobs(state,updated_at,evidence_id);

CREATE INDEX IF NOT EXISTS execution_task ON executions(task_id, attempt_no DESC);

CREATE INDEX IF NOT EXISTS inbox_pending_retry ON inbox(retry_attempts,received_at,inbox_id) WHERE processed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS lease_one_writer ON leases(resource_key) WHERE mode='write' AND lease_state IN ('requested','active','recovery_hold');

CREATE INDEX IF NOT EXISTS outbox_dispatch ON outbox(outbox_state, available_at);

CREATE UNIQUE INDEX IF NOT EXISTS route_one_per_trigger
ON route_decisions(trigger_id)
WHERE trigger_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS session_last_seen ON session_refs(system, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS source_content_hash ON source_records(content_hash);

CREATE INDEX IF NOT EXISTS source_external ON source_records(source_system, external_id, occurred_at);

CREATE INDEX IF NOT EXISTS task_project_state ON tasks(project_id, task_state, updated_at DESC);

CREATE INDEX IF NOT EXISTS task_session_ref ON task_sessions(session_ref_id);

CREATE TABLE IF NOT EXISTS analysis_runs (
  run_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','cancelled','interrupted')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  session_id TEXT,
  parent_session_id TEXT,
  log_available INTEGER NOT NULL DEFAULT 0,
  input_count INTEGER NOT NULL DEFAULT 0,
  model_json TEXT,
  result_json TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS analysis_runs_purpose_time ON analysis_runs(purpose,started_at DESC);
CREATE INDEX IF NOT EXISTS analysis_runs_session ON analysis_runs(session_id);
CREATE INDEX IF NOT EXISTS analysis_runs_parent ON analysis_runs(parent_session_id);

CREATE TABLE IF NOT EXISTS history_sessions (
  session_ref_id TEXT PRIMARY KEY REFERENCES session_refs(session_ref_id),
  title TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  published_revision INTEGER NOT NULL DEFAULT 0,
  scan_complete INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS history_messages (
  message_id TEXT PRIMARY KEY,
  session_ref_id TEXT NOT NULL REFERENCES history_sessions(session_ref_id),
  source_json TEXT NOT NULL,
  staged_text TEXT,
  content_hash TEXT NOT NULL,
  occurred_at TEXT,
  source_order INTEGER NOT NULL,
  ownership TEXT NOT NULL DEFAULT 'unprocessed' CHECK(ownership IN ('unprocessed','unresolved','no-task','assigned')),
  evidence_id TEXT REFERENCES evidence(evidence_id)
) STRICT;
CREATE INDEX IF NOT EXISTS history_message_order ON history_messages(session_ref_id,source_order,message_id);
CREATE TABLE IF NOT EXISTS session_tasks (
  session_task_id TEXT PRIMARY KEY,
  session_ref_id TEXT NOT NULL REFERENCES history_sessions(session_ref_id),
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL,
  first_activity_at TEXT,
  last_activity_at TEXT,
  context_version TEXT NOT NULL,
  extracted_version TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS session_task_messages (
  session_task_id TEXT NOT NULL REFERENCES session_tasks(session_task_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES history_messages(message_id) ON DELETE CASCADE,
  PRIMARY KEY(session_task_id,message_id)
) STRICT;
CREATE TABLE IF NOT EXISTS session_task_memories (
  session_task_id TEXT NOT NULL REFERENCES session_tasks(session_task_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_records(memory_id) ON DELETE CASCADE,
  PRIMARY KEY(session_task_id,memory_id)
) STRICT;
CREATE TABLE IF NOT EXISTS history_exclusions (
  message_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
) STRICT;
