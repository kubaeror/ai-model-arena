import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { listRuns, getRunRecord } from '../../orchestrator/orchestrator.js';

function readResultFile(resultPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(resultPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } catch {
    return null;
  }
}

function readJudgeScore(outputDir: string): Record<string, unknown> | null {
  const judgePath = path.join(outputDir, 'judge_score.json');
  if (!fs.existsSync(judgePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(judgePath, 'utf8'));
  } catch {
    return null;
  }
}

function escapeCSV(str: string): string {
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

interface ExportFilters {
  model?: string;
  scenario?: string;
  from?: string;
  to?: string;
}

export function createExportRouter(): Router {
  const router = Router();
  
  router.get('/csv', (req, res) => {
    const { model: filterModel, scenario: filterScenario, from, to } = req.query as ExportFilters;
    const runs = listRuns();
    
    let filteredRuns = runs;
    
    if (from) {
      const fromDate = new Date(from);
      filteredRuns = filteredRuns.filter(r => new Date(r.startedAt) >= fromDate);
    }
    if (to) {
      const toDate = new Date(to);
      filteredRuns = filteredRuns.filter(r => new Date(r.startedAt) <= toDate);
    }
    if (filterScenario) {
      filteredRuns = filteredRuns.filter(r => r.scenario === filterScenario);
    }
    
    const rows: string[][] = [];
    rows.push([
      'run_id', 'model', 'scenario', 'started_at', 'duration_seconds', 
      'turns_used', 'success', 'judge_score_avg', 'total_tokens', 
      'estimated_cost_usd', 'accepted_change_rate'
    ]);
    
    for (const run of filteredRuns) {
      for (const perModel of run.perModel) {
        if (filterModel && perModel.model !== filterModel) continue;
        
        const result = readResultFile(perModel.resultPath);
        if (!result) continue;
        
        const judgeScore = readJudgeScore(perModel.outputDir);
        const judgeAvg = (judgeScore?.averageScore as number) ?? '';
        const tokenUsage = result.tokenUsage as Record<string, number> | undefined;
        const totalTokens = (tokenUsage?.prompt ?? 0) + (tokenUsage?.completion ?? 0);
        
        rows.push([
          escapeCSV(run.runId),
          escapeCSV(perModel.model),
          escapeCSV(run.scenario),
          escapeCSV(run.startedAt),
          String(Math.round((result.durationMs as number) ?? 0) / 1000),
          String(result.turnsUsed ?? 0),
          result.success === true ? 'true' : 'false',
          String(judgeAvg),
          String(totalTokens),
          String((result.costUsd as number) ?? 0),
          result.success === true ? '1' : '0',
        ]);
      }
    }
    
    const csv = rows.map(r => r.join(',')).join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="arena-export.csv"');
    res.send(csv);
  });
  
  router.get('/runs/:runId/csv', (req, res) => {
    const { runId } = req.params;
    const run = getRunRecord(runId);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    
    const rows: string[][] = [];
    rows.push(['turn_number', 'role', 'content_summary', 'tool_name', 'tool_success']);
    
    for (const perModel of run.perModel) {
      if (!fs.existsSync(perModel.conversationPath)) continue;
      
      try {
        const conv = JSON.parse(fs.readFileSync(perModel.conversationPath, 'utf8'));
        const entries = (conv.entries as Array<Record<string, unknown>>) ?? [];
        
        let currentTurn = 0;
        for (const entry of entries) {
          const type = entry.type as string;
          
          if (type === 'user' || type === 'system') {
            const content = ((entry.content as string) ?? '').slice(0, 100).replace(/[\n,]/g, ' ');
            rows.push([
              String(currentTurn),
              type,
              escapeCSV(content),
              '',
              ''
            ]);
          } else if (type === 'assistant') {
            currentTurn = (entry.turn as number) ?? currentTurn + 1;
            const content = ((entry.content as string) ?? '').slice(0, 100).replace(/[\n,]/g, ' ');
            rows.push([
              String(currentTurn),
              'assistant',
              escapeCSV(content),
              '',
              ''
            ]);
          } else if (type === 'tool_call') {
            rows.push([
              String(currentTurn),
              'tool_call',
              '',
              escapeCSV(entry.toolName as string),
              ''
            ]);
          } else if (type === 'tool_result') {
            const isSuccess = !(entry.isError as boolean);
            rows.push([
              String(currentTurn),
              'tool_result',
              '',
              escapeCSV(entry.toolName as string),
              isSuccess ? 'true' : 'false'
            ]);
          }
        }
      } catch {
        continue;
      }
    }
    
    const csv = rows.map(r => r.join(',')).join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${runId}-conversation.csv"`);
    res.send(csv);
  });
  
  return router;
}
