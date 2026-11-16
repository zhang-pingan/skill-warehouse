import { randomUUID } from 'node:crypto'
import { backgroundLanguage } from './session-history.js'
import { managedAnalysis } from './managed-analysis.js'

/** Operational run metadata; complete inputs and outputs remain in Harness Session logs. */
export class AnalysisRuns {
  /**
   * @param db - Plugin SQLite connection, retained until all analyses settle.
   * @param context - Harness services that own native Agents and subagents.
   * @param options - Clock and service cancellation signal.
   */
  constructor(db, context, { clock = Date.now, signal } = {}) {
    this.db = db
    this.context = context
    this.clock = clock
    this.signal = signal
    db.prepare("UPDATE analysis_runs SET state='interrupted',finished_at=?,error=? WHERE state='running'")
      .run(this.at(), 'Host stopped before the analysis settled')
  }

  /** Return the current recording time as ISO text. */
  at() { return new Date(this.clock()).toISOString() }

  /**
   * @param purpose - Analysis purpose whose recent runs should be returned.
   * @param limit - Maximum number of records.
   * @returns Latest operational summaries and durable log addresses.
   */
  list(purpose, limit = 20) {
    return this.db.prepare('SELECT * FROM analysis_runs WHERE purpose=? ORDER BY started_at DESC,run_id DESC LIMIT ?').all(purpose, limit).map(row => ({
      id: row.run_id, state: row.state, startedAt: row.started_at, finishedAt: row.finished_at,
      sessionId: row.session_id, parentSessionId: row.parent_session_id, logAvailable: row.log_available === 1, inputCount: row.input_count,
      result: row.result_json ? JSON.parse(row.result_json) : null, error: row.error,
      model: row.model_json ? JSON.parse(row.model_json) : null,
    }))
  }

  /** Page failed runs before limiting; successful and empty-success runs are excluded. */
  failures({cursor=null,limit=20}={}) {
    const count=Math.min(100,Math.max(1,Number(limit)||20))
    let at=null,id=null
    if(cursor) { const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString()); if(!Array.isArray(parsed)||parsed.length!==2||parsed.some(x=>typeof x!=='string'))throw new Error('Invalid failure cursor'); [at,id]=parsed }
    const rows=this.db.prepare(`SELECT * FROM analysis_runs WHERE purpose IN ('memory-extraction','session-segmentation') AND state IN ('failed','interrupted','cancelled')
      AND (? IS NULL OR started_at<? OR (started_at=? AND run_id<?)) ORDER BY started_at DESC,run_id DESC LIMIT ?`).all(at,at,at,id,count+1)
    const last=rows[Math.min(count,rows.length)-1]
    return {total:this.db.prepare("SELECT COUNT(*) AS n FROM analysis_runs WHERE purpose IN ('memory-extraction','session-segmentation') AND state IN ('failed','interrupted','cancelled')").get().n,runs:rows.slice(0,count).map(row=>({model:row.model_json?JSON.parse(row.model_json):null,purpose:row.purpose,id:row.run_id,state:row.state,startedAt:row.started_at,finishedAt:row.finished_at,sessionId:row.session_id,parentSessionId:row.parent_session_id,logAvailable:row.log_available===1,inputCount:row.input_count,error:row.error})),nextCursor:rows.length>count?Buffer.from(JSON.stringify([last.started_at,last.run_id])).toString('base64url'):null}
  }

  /**
   * Record success after synchronous validation and database writes succeed.
   * @param options - Recorded analysis input, model selection and budgets.
   * @param commit - Optional synchronous validation/write callback returning summary counts.
   * @returns Parsed analysis output and its durable child address.
   */
  async run(options, commit) {
    if (options.defaultLanguage) options = {...options,instructions:options.instructions+backgroundLanguage(options)}
    const signal = this.signal && options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal ?? options.signal
    signal?.throwIfAborted()
    const id = randomUUID()
    this.db.prepare("INSERT INTO analysis_runs(run_id,purpose,state,started_at,input_count,model_json) VALUES(?,?,'running',?,?,?)")
      .run(id, options.purpose, this.at(), options.input.evidence?.length ?? options.input.messages?.length ?? 0, JSON.stringify(options.selection ?? null))
    try {
      const result = await managedAnalysis(this.context, { ...options, signal, onSession: ({ sessionId, parentSessionId, available }) => {
        this.db.prepare('UPDATE analysis_runs SET session_id=?,parent_session_id=?,log_available=? WHERE run_id=?').run(sessionId, parentSessionId, available ? 1 : 0, id)
      } })
      const summary = commit ? commit(result.value) : null
      this.db.prepare("UPDATE analysis_runs SET state='succeeded',finished_at=?,result_json=? WHERE run_id=?")
        .run(this.at(), JSON.stringify(summary), id)
      return result
    } catch (error) {
      this.db.prepare('UPDATE analysis_runs SET state=?,finished_at=?,error=? WHERE run_id=?')
        .run(signal?.aborted ? 'cancelled' : 'failed', this.at(), String(error?.message ?? error).slice(0, 1000), id)
      throw error
    }
  }
}
