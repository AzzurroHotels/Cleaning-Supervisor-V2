const express = require('express');
const { requireAuth } = require('../auth');
const { FLOORS } = require('../checklist');
const { summarizeInspection } = require('../inspection-data');
const { wrap, todayLocal, addDays } = require('../util');

function createStatsRouter({ db }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get(
    '/',
    wrap((req, res) => {
      const mine = req.user.role === 'supervisor';
      const scope = mine ? ' AND inspector_id = ?' : '';
      const scopeParams = mine ? [req.user.id] : [];
      const today = todayLocal();
      const weekStart = addDays(today, -6);
      const monthStart = addDays(today, -29);

      const todayRow = db
        .prepare(`
          SELECT
            COUNT(*) AS inspections,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
            COALESCE(SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END), 0) AS drafts,
            COALESCE(SUM(pass_count), 0) AS pass,
            COALESCE(SUM(fail_count), 0) AS fail,
            COALESCE(SUM(total_items), 0) AS total_items
          FROM inspections
          WHERE date = ?${scope}
        `)
        .get(today, ...scopeParams);

      const weekRows = db
        .prepare(`
          SELECT
            date,
            COUNT(*) AS inspections,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
            COALESCE(SUM(pass_count), 0) AS pass,
            COALESCE(SUM(fail_count), 0) AS fail
          FROM inspections
          WHERE date >= ? AND date <= ?${scope}
          GROUP BY date
          ORDER BY date ASC
        `)
        .all(weekStart, today, ...scopeParams);

      const weekMap = new Map(weekRows.map((row) => [row.date, row]));
      const trend = [];
      for (let offset = 0; offset < 7; offset += 1) {
        const date = addDays(weekStart, offset);
        const row = weekMap.get(date);
        trend.push({
          date,
          inspections: row?.inspections || 0,
          completed: row?.completed || 0,
          pass: row?.pass || 0,
          fail: row?.fail || 0
        });
      }

      const week = trend.reduce(
        (totals, day) => {
          totals.inspections += day.inspections;
          totals.completed += day.completed;
          totals.pass += day.pass;
          totals.fail += day.fail;
          return totals;
        },
        { inspections: 0, completed: 0, pass: 0, fail: 0 }
      );
      week.checked = week.pass + week.fail;
      week.passRate = week.checked ? Math.round((week.pass / week.checked) * 1000) / 10 : 0;
      week.trend = trend;

      const topFailures = db
        .prepare(`
          SELECT
            r.floor,
            r.group_name AS groupName,
            r.item_text AS itemText,
            COUNT(*) AS count
          FROM results r
          JOIN inspections i ON i.id = r.inspection_id
          WHERE r.result = 'fail' AND i.date >= ? AND i.date <= ?${mine ? ' AND i.inspector_id = ?' : ''}
          GROUP BY r.floor, r.group_name, r.item_text
          ORDER BY count DESC, r.floor ASC, r.group_name ASC
          LIMIT 6
        `)
        .all(monthStart, today, ...scopeParams);

      const floorRows = db
        .prepare(`
          SELECT
            r.floor,
            COALESCE(SUM(CASE WHEN r.result = 'fail' THEN 1 ELSE 0 END), 0) AS fails,
            COALESCE(SUM(CASE WHEN r.result = 'pass' THEN 1 ELSE 0 END), 0) AS passes
          FROM results r
          JOIN inspections i ON i.id = r.inspection_id
          WHERE i.date >= ? AND i.date <= ?${mine ? ' AND i.inspector_id = ?' : ''}
          GROUP BY r.floor
        `)
        .all(monthStart, today, ...scopeParams);
      const floorMap = new Map(floorRows.map((row) => [row.floor, row]));
      const floors = FLOORS.map((floor) => ({
        floor,
        fails: floorMap.get(floor)?.fails || 0,
        passes: floorMap.get(floor)?.passes || 0
      }));

      const recentRows = db
        .prepare(`
          SELECT * FROM inspections
          WHERE 1 = 1${scope}
          ORDER BY updated_at DESC
          LIMIT 6
        `)
        .all(...scopeParams);

      const draftRow = mine
        ? db
            .prepare(
              "SELECT * FROM inspections WHERE inspector_id = ? AND status = 'draft' ORDER BY updated_at DESC LIMIT 1"
            )
            .get(req.user.id)
        : null;

      const inspectors =
        req.user.role === 'manager'
          ? db
              .prepare(
                "SELECT id, name FROM users WHERE role = 'supervisor' AND active = 1 ORDER BY name COLLATE NOCASE"
              )
              .all()
          : [];

      const todayChecked = todayRow.pass + todayRow.fail;
      res.json({
        scope: mine ? 'mine' : 'all',
        today: {
          date: today,
          inspections: todayRow.inspections,
          completed: todayRow.completed,
          drafts: todayRow.drafts,
          pass: todayRow.pass,
          fail: todayRow.fail,
          checked: todayChecked,
          totalItems: todayRow.total_items,
          completion: todayRow.total_items
            ? Math.round((todayChecked / todayRow.total_items) * 1000) / 10
            : 0
        },
        week: {
          start: weekStart,
          end: today,
          ...week
        },
        topFailures,
        floors,
        recent: recentRows.map(summarizeInspection),
        activeDraft: draftRow ? summarizeInspection(draftRow) : null,
        inspectors
      });
    })
  );

  return router;
}

module.exports = { createStatsRouter };
