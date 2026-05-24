function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function toDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDayKey(dayKey) {
  const [year, month, day] = String(dayKey).split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function shortDate(dayKey) {
  const parts = String(dayKey).split('-');
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : String(dayKey);
}

function hourLabel(hour, compact = false) {
  const normalized = ((hour % 24) + 24) % 24;
  const value = normalized === 0 ? 12 : (normalized > 12 ? normalized - 12 : normalized);
  const suffix = normalized < 12 ? (compact ? 'a' : 'AM') : (compact ? 'p' : 'PM');
  return compact ? `${value}${suffix}` : `${value} ${suffix}`;
}

function hourRangeLabel(startHour, endHour, compact = false) {
  const start = hourLabel(startHour, compact);
  const end = hourLabel(endHour % 24, compact);
  return compact ? `${start}-${end}` : `${start} - ${end}`;
}

function monthYearLabel(date) {
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function quarterStart(date) {
  const startMonth = Math.floor(date.getMonth() / 3) * 3;
  return new Date(date.getFullYear(), startMonth, 1);
}

function quarterLabel(date) {
  return `Q${Math.floor(date.getMonth() / 3) + 1} ${date.getFullYear()}`;
}

function yearLabel(date) {
  return String(date.getFullYear());
}

function startOfWeek(date) {
  const value = startOfLocalDay(date);
  value.setDate(value.getDate() - value.getDay());
  return value;
}

function mapDailyEntries(daily) {
  const entryByDate = new Map();
  for (const entry of Array.isArray(daily) ? daily : []) {
    if (entry?.date) entryByDate.set(entry.date, entry);
  }
  return entryByDate;
}

function aggregateSeriesRange(entryByDate, start, end) {
  let cost = 0;
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const cursor = new Date(start.getTime());

  while (cursor < end) {
    const entry = entryByDate.get(toDayKey(cursor));
    if (entry) {
      cost += Number(entry.cost) || 0;
      calls += Number(entry.calls) || 0;
      inputTokens += Number(entry.inputTokens) || 0;
      outputTokens += Number(entry.outputTokens) || 0;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return { cost, calls, inputTokens, outputTokens };
}

function buildDailySeries(daily, dayCount, now = new Date()) {
  const today = startOfLocalDay(now);
  const todayKey = toDayKey(today);
  const entryByDate = mapDailyEntries(daily);
  const points = [];

  for (let offset = dayCount - 1; offset >= 0; offset--) {
    const day = new Date(today.getTime());
    day.setDate(day.getDate() - offset);
    const key = toDayKey(day);
    const entry = entryByDate.get(key);
    points.push({
      id: key,
      label: key,
      cost: Number(entry?.cost) || 0,
      calls: Number(entry?.calls) || 0,
      inputTokens: Number(entry?.inputTokens) || 0,
      outputTokens: Number(entry?.outputTokens) || 0,
      isCurrent: key === todayKey,
    });
  }

  return points;
}

function buildIntradaySeries(intraday, now = new Date()) {
  const currentHour = now.getHours();
  return (Array.isArray(intraday) ? intraday : []).map(bucket => ({
    id: `hour-${bucket.bucketStartHour}`,
    label: hourRangeLabel(bucket.bucketStartHour, bucket.bucketEndHour, false),
    cost: Number(bucket.cost) || 0,
    calls: Number(bucket.calls) || 0,
    inputTokens: Number(bucket.inputTokens) || 0,
    outputTokens: Number(bucket.outputTokens) || 0,
    isCurrent: currentHour >= bucket.bucketStartHour && currentHour < bucket.bucketEndHour,
  }));
}

function buildWeeklySeries(daily, weekCount, now = new Date()) {
  const entryByDate = mapDailyEntries(daily);
  const currentWeekStart = startOfWeek(now);
  const points = [];

  for (let offset = weekCount - 1; offset >= 0; offset--) {
    const start = new Date(currentWeekStart.getTime());
    start.setDate(start.getDate() - offset * 7);
    const end = new Date(start.getTime());
    end.setDate(end.getDate() + 7);
    const key = toDayKey(start);
    const aggregate = aggregateSeriesRange(entryByDate, start, end);
    points.push({
      id: `week-${key}`,
      label: `Week of ${shortDate(key)}`,
      cost: aggregate.cost,
      calls: aggregate.calls,
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      isCurrent: offset === 0,
    });
  }

  return points;
}

function buildMonthlySeries(daily, monthCount, now = new Date()) {
  const entryByDate = mapDailyEntries(daily);
  const today = startOfLocalDay(now);
  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const points = [];

  for (let offset = monthCount - 1; offset >= 0; offset--) {
    const start = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - offset, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const aggregate = aggregateSeriesRange(entryByDate, start, end);
    points.push({
      id: `month-${toDayKey(start)}`,
      label: monthYearLabel(start),
      cost: aggregate.cost,
      calls: aggregate.calls,
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      isCurrent: offset === 0,
    });
  }

  return points;
}

function buildQuarterlySeries(daily, quarterCount, now = new Date()) {
  const entryByDate = mapDailyEntries(daily);
  const currentQuarterStart = quarterStart(now);
  const points = [];

  for (let offset = quarterCount - 1; offset >= 0; offset--) {
    const start = new Date(currentQuarterStart.getFullYear(), currentQuarterStart.getMonth() - offset * 3, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 3, 1);
    const aggregate = aggregateSeriesRange(entryByDate, start, end);
    points.push({
      id: `quarter-${toDayKey(start)}`,
      label: quarterLabel(start),
      cost: aggregate.cost,
      calls: aggregate.calls,
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      isCurrent: offset === 0,
    });
  }

  return points;
}

function buildYearlySeries(daily, yearCount, now = new Date()) {
  const entryByDate = mapDailyEntries(daily);
  const currentYearStart = new Date(now.getFullYear(), 0, 1);
  const points = [];

  for (let offset = yearCount - 1; offset >= 0; offset--) {
    const start = new Date(currentYearStart.getFullYear() - offset, 0, 1);
    const end = new Date(start.getFullYear() + 1, 0, 1);
    const aggregate = aggregateSeriesRange(entryByDate, start, end);
    points.push({
      id: `year-${toDayKey(start)}`,
      label: yearLabel(start),
      cost: aggregate.cost,
      calls: aggregate.calls,
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      isCurrent: offset === 0,
    });
  }

  return points;
}

export function lifetimeMonthSpan(daily, now = new Date()) {
  if (!Array.isArray(daily) || daily.length === 0) return 1;
  const firstKey = daily.map(entry => entry.date).sort()[0];
  if (!firstKey) return 1;
  const firstDate = parseDayKey(firstKey);
  const today = startOfLocalDay(now);
  const diff = (today.getFullYear() - firstDate.getFullYear()) * 12 + (today.getMonth() - firstDate.getMonth());
  return Math.max(diff + 1, 1);
}

export function buildPeriodSeries(period, payload, now = new Date()) {
  const daily = Array.isArray(payload?.history?.daily) ? payload.history.daily : [];
  const intraday = Array.isArray(payload?.history?.intraday) ? payload.history.intraday : [];

  switch (period) {
    case 'today':
      return {
        windowLabel: 'Today',
        points: intraday.length ? buildIntradaySeries(intraday, now) : buildDailySeries(daily, 1, now),
      };
    case 'week':
      return {
        windowLabel: 'Last 7 days',
        points: buildDailySeries(daily, 7, now),
      };
    case '30days':
      return {
        windowLabel: 'Last 30 days',
        points: buildDailySeries(daily, 30, now),
      };
    case 'month':
      return {
        windowLabel: 'Month to date',
        points: buildDailySeries(daily, Math.max(now.getDate(), 1), now),
      };
    case 'all':
      return {
        windowLabel: 'Recent 26 weeks',
        points: buildWeeklySeries(daily, 26, now),
      };
    case 'lifetime': {
      const monthSpan = lifetimeMonthSpan(daily, now);
      if (monthSpan <= 24) {
        return {
          windowLabel: 'All time by month',
          points: buildMonthlySeries(daily, monthSpan, now),
        };
      }
      if (monthSpan <= 60) {
        return {
          windowLabel: 'All time by quarter',
          points: buildQuarterlySeries(daily, Math.ceil(monthSpan / 3), now),
        };
      }
      return {
        windowLabel: 'All time by year',
        points: buildYearlySeries(daily, Math.ceil(monthSpan / 12), now),
      };
    }
    default:
      return {
        windowLabel: 'Last 7 days',
        points: buildDailySeries(daily, 7, now),
      };
  }
}