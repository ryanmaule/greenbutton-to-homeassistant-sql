#!/usr/bin/env node
/**
 * Merge Green Button XML files
 *
 * Merges data from multiple Green Button XML files, keeping unique timestamps
 * and preferring newer file data when timestamps overlap.
 *
 * Usage:
 *   node merge-greenbutton.js <primary.xml> <secondary.xml> [output.sql] [--clear]
 *
 * The secondary file provides data for dates NOT present in the primary file.
 * Primary file data takes precedence for overlapping dates.
 */

const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

// Configuration (same as greenbutton-to-sql.js)
const CONFIG = {
  costDivisor: 100000,
  consumptionDivisor: 1000000,
  timezone: 'America/Toronto',
  touMapping: {
    1: 'On-Peak',
    2: 'Mid-Peak',
    3: 'Off-Peak'
  },
  statisticIds: {
    onPeak: 'hydroone:on_peak',
    midPeak: 'hydroone:mid_peak',
    offPeak: 'hydroone:off_peak',
    onPeakCost: 'hydroone:on_peak_cost',
    midPeakCost: 'hydroone:mid_peak_cost',
    offPeakCost: 'hydroone:off_peak_cost',
    dailyUsage: 'hydroone:daily_usage',
    dailyCost: 'hydroone:daily_cost'
  }
};

/**
 * Parse Green Button XML and extract interval readings
 */
async function parseGreenButtonXML(xmlPath) {
  const xmlContent = fs.readFileSync(xmlPath, 'utf-8');
  const parser = new xml2js.Parser({
    tagNameProcessors: [xml2js.processors.stripPrefix],
    attrNameProcessors: [xml2js.processors.stripPrefix]
  });
  const result = await parser.parseStringPromise(xmlContent);

  const readings = [];
  const entries = result.feed.entry || [];

  for (const entry of entries) {
    const content = entry.content && entry.content[0];
    if (!content) continue;

    const intervalBlocks = content.IntervalBlock;
    if (!intervalBlocks) continue;

    for (const block of intervalBlocks) {
      const intervalReadings = block.IntervalReading;
      if (!intervalReadings) continue;

      for (const reading of intervalReadings) {
        const timePeriod = reading.timePeriod && reading.timePeriod[0];
        if (!timePeriod) continue;

        const startTimestamp = parseInt(timePeriod.start && timePeriod.start[0]);
        const duration = parseInt(timePeriod.duration && timePeriod.duration[0]);

        if (duration !== 3600) continue;

        const value = parseInt((reading.value && reading.value[0]) || 0);
        const cost = parseInt((reading.cost && reading.cost[0]) || 0);
        const tou = parseInt((reading.tou && reading.tou[0]) || 3);

        if (value === 0 && cost === 0) continue;

        readings.push({
          timestamp: startTimestamp,
          consumption: value / CONFIG.consumptionDivisor,
          cost: cost / CONFIG.costDivisor,
          tou: tou,
          touName: CONFIG.touMapping[tou] || 'Off-Peak'
        });
      }
    }
  }

  readings.sort((a, b) => a.timestamp - b.timestamp);
  return readings;
}

/**
 * Merge two arrays of readings, preferring primary data for overlapping timestamps
 */
function mergeReadings(primary, secondary) {
  // Create a map of primary timestamps for fast lookup
  const primaryTimestamps = new Set(primary.map(r => r.timestamp));

  // Get secondary readings that don't exist in primary
  const uniqueSecondary = secondary.filter(r => !primaryTimestamps.has(r.timestamp));

  // Combine and sort
  const merged = [...primary, ...uniqueSecondary];
  merged.sort((a, b) => a.timestamp - b.timestamp);

  return merged;
}

/**
 * Group hourly readings by TOU tier
 */
function groupByTOU(readings) {
  const groups = {
    onPeak: [],
    midPeak: [],
    offPeak: []
  };

  for (const reading of readings) {
    switch (reading.tou) {
      case 1:
        groups.onPeak.push(reading);
        break;
      case 2:
        groups.midPeak.push(reading);
        break;
      case 3:
      default:
        groups.offPeak.push(reading);
        break;
    }
  }

  return groups;
}

/**
 * Aggregate hourly readings into daily totals
 */
function aggregateToDaily(readings) {
  const dailyMap = new Map();

  for (const reading of readings) {
    const date = new Date(reading.timestamp * 1000);
    const torontoDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
    const dateKey = torontoDate.toISOString().split('T')[0];

    if (!dailyMap.has(dateKey)) {
      dailyMap.set(dateKey, {
        date: dateKey,
        consumption: 0,
        cost: 0
      });
    }

    const daily = dailyMap.get(dateKey);
    daily.consumption += reading.consumption;
    daily.cost += reading.cost;
  }

  const dailyArray = Array.from(dailyMap.values());
  dailyArray.sort((a, b) => a.date.localeCompare(b.date));

  return dailyArray.map(d => {
    const [year, month, day] = d.date.split('-').map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day, 5, 0, 0));
    return {
      timestamp: Math.floor(utcDate.getTime() / 1000),
      consumption: d.consumption,
      cost: d.cost,
      date: d.date
    };
  });
}

/**
 * Generate SQL for statistics_meta table
 */
function generateMetaSQL() {
  const metas = [
    { id: CONFIG.statisticIds.onPeak, name: 'HydroOne On-Peak', unit: 'kWh' },
    { id: CONFIG.statisticIds.midPeak, name: 'HydroOne Mid-Peak', unit: 'kWh' },
    { id: CONFIG.statisticIds.offPeak, name: 'HydroOne Off-Peak', unit: 'kWh' },
    { id: CONFIG.statisticIds.onPeakCost, name: 'HydroOne On-Peak Cost', unit: 'CAD' },
    { id: CONFIG.statisticIds.midPeakCost, name: 'HydroOne Mid-Peak Cost', unit: 'CAD' },
    { id: CONFIG.statisticIds.offPeakCost, name: 'HydroOne Off-Peak Cost', unit: 'CAD' },
    { id: CONFIG.statisticIds.dailyUsage, name: 'HydroOne Daily Usage', unit: 'kWh' },
    { id: CONFIG.statisticIds.dailyCost, name: 'HydroOne Daily Cost', unit: 'CAD' }
  ];

  let sql = '-- Statistics Metadata\n';
  sql += '-- Run these INSERT statements first. If records already exist, they will be ignored.\n\n';

  for (const meta of metas) {
    sql += `INSERT IGNORE INTO statistics_meta (statistic_id, source, unit_of_measurement, has_mean, has_sum, name) VALUES ('${meta.id}', 'hydroone', '${meta.unit}', 0, 1, '${meta.name}');\n`;
  }

  return sql;
}

/**
 * Generate SQL INSERT statements for a single statistic
 */
function generateStatisticSQL(statisticId, readings, valueField) {
  if (readings.length === 0) return '';

  let sql = `\n-- ${statisticId}\n`;
  sql += `-- ${readings.length} records\n`;

  let cumulativeSum = 0;
  const values = [];

  for (const reading of readings) {
    const value = reading[valueField];
    cumulativeSum += value;

    const roundedValue = Math.round(value * 1000000) / 1000000;
    const roundedSum = Math.round(cumulativeSum * 1000000) / 1000000;

    const startTs = typeof reading.timestamp === 'number'
      ? reading.timestamp
      : Math.floor(new Date(reading.timestamp).getTime() / 1000);
    const createdTs = startTs;

    values.push(`((SELECT id FROM statistics_meta WHERE statistic_id = '${statisticId}'), ${createdTs}, ${startTs}, ${roundedValue}, ${roundedSum})`);
  }

  const batchSize = 500;
  for (let i = 0; i < values.length; i += batchSize) {
    const batch = values.slice(i, i + batchSize);
    sql += `INSERT IGNORE INTO statistics (metadata_id, created_ts, start_ts, state, sum) VALUES\n`;
    sql += batch.join(',\n') + ';\n';
  }

  return sql;
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: node merge-greenbutton.js <primary.xml> <secondary.xml> [output.sql] [--clear]');
    console.error('');
    console.error('Merges data from secondary.xml into primary.xml for dates not in primary.');
    console.error('Primary file data takes precedence for overlapping dates.');
    process.exit(1);
  }

  const xmlFiles = args.filter(a => !a.startsWith('--') && a.endsWith('.xml'));
  const primaryPath = xmlFiles[0];
  const secondaryPath = xmlFiles[1];
  const outputPath = args.find(a => !a.startsWith('--') && a.endsWith('.sql')) || 'merged.sql';
  const clearExisting = args.includes('--clear');

  if (!fs.existsSync(primaryPath)) {
    console.error(`Error: Primary file not found: ${primaryPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(secondaryPath)) {
    console.error(`Error: Secondary file not found: ${secondaryPath}`);
    process.exit(1);
  }

  console.log(`Parsing primary file: ${primaryPath}`);
  const primaryReadings = await parseGreenButtonXML(primaryPath);
  console.log(`  Found ${primaryReadings.length} hourly readings`);

  console.log(`Parsing secondary file: ${secondaryPath}`);
  const secondaryReadings = await parseGreenButtonXML(secondaryPath);
  console.log(`  Found ${secondaryReadings.length} hourly readings`);

  console.log('Merging readings...');
  const mergedReadings = mergeReadings(primaryReadings, secondaryReadings);
  console.log(`  Merged total: ${mergedReadings.length} hourly readings`);
  console.log(`  Added from secondary: ${mergedReadings.length - primaryReadings.length} readings`);

  if (mergedReadings.length === 0) {
    console.error('Error: No valid readings found');
    process.exit(1);
  }

  const firstDate = new Date(mergedReadings[0].timestamp * 1000);
  const lastDate = new Date(mergedReadings[mergedReadings.length - 1].timestamp * 1000);
  console.log(`Date range: ${firstDate.toISOString().split('T')[0]} to ${lastDate.toISOString().split('T')[0]}`);

  const touGroups = groupByTOU(mergedReadings);
  console.log(`  On-Peak:  ${touGroups.onPeak.length} readings`);
  console.log(`  Mid-Peak: ${touGroups.midPeak.length} readings`);
  console.log(`  Off-Peak: ${touGroups.offPeak.length} readings`);

  const dailyReadings = aggregateToDaily(mergedReadings);
  console.log(`Aggregated to ${dailyReadings.length} daily records`);

  // Generate SQL
  let sql = '-- Green Button to Home Assistant Statistics Import (MERGED)\n';
  sql += `-- Generated: ${new Date().toISOString()}\n`;
  sql += `-- Primary source: ${path.basename(primaryPath)}\n`;
  sql += `-- Secondary source: ${path.basename(secondaryPath)}\n`;
  sql += `-- Date range: ${firstDate.toISOString().split('T')[0]} to ${lastDate.toISOString().split('T')[0]}\n`;
  sql += `-- Total hourly readings: ${mergedReadings.length}\n`;
  sql += `-- Total daily records: ${dailyReadings.length}\n`;
  sql += '\n';

  if (clearExisting) {
    sql += '-- ==========================================\n';
    sql += '-- CLEARING EXISTING DATA\n';
    sql += '-- ==========================================\n';
    sql += 'DELETE FROM statistics WHERE metadata_id IN (SELECT id FROM statistics_meta WHERE statistic_id LIKE \'hydroone:%\');\n';
    sql += 'DELETE FROM statistics_short_term WHERE metadata_id IN (SELECT id FROM statistics_meta WHERE statistic_id LIKE \'hydroone:%\');\n';
    sql += '\n';
    console.log('Including DELETE statements to clear existing data');
  } else {
    sql += '-- NOTE: Using INSERT IGNORE to skip duplicate records.\n';
    sql += '-- To clear existing data first, run with --clear flag or execute:\n';
    sql += '-- DELETE FROM statistics WHERE metadata_id IN (SELECT id FROM statistics_meta WHERE statistic_id LIKE \'hydroone:%\');\n';
    sql += '-- DELETE FROM statistics_short_term WHERE metadata_id IN (SELECT id FROM statistics_meta WHERE statistic_id LIKE \'hydroone:%\');\n';
    sql += '\n';
  }

  sql += generateMetaSQL();
  sql += '\n';

  sql += '\n-- ==========================================\n';
  sql += '-- HOURLY TOU STATISTICS\n';
  sql += '-- ==========================================\n';

  sql += generateStatisticSQL(CONFIG.statisticIds.onPeak, touGroups.onPeak, 'consumption');
  sql += generateStatisticSQL(CONFIG.statisticIds.midPeak, touGroups.midPeak, 'consumption');
  sql += generateStatisticSQL(CONFIG.statisticIds.offPeak, touGroups.offPeak, 'consumption');
  sql += generateStatisticSQL(CONFIG.statisticIds.onPeakCost, touGroups.onPeak, 'cost');
  sql += generateStatisticSQL(CONFIG.statisticIds.midPeakCost, touGroups.midPeak, 'cost');
  sql += generateStatisticSQL(CONFIG.statisticIds.offPeakCost, touGroups.offPeak, 'cost');

  sql += '\n-- ==========================================\n';
  sql += '-- DAILY AGGREGATE STATISTICS\n';
  sql += '-- ==========================================\n';

  sql += generateStatisticSQL(CONFIG.statisticIds.dailyUsage, dailyReadings, 'consumption');
  sql += generateStatisticSQL(CONFIG.statisticIds.dailyCost, dailyReadings, 'cost');

  fs.writeFileSync(outputPath, sql);
  console.log(`\nSQL written to: ${outputPath}`);

  const totalConsumption = mergedReadings.reduce((sum, r) => sum + r.consumption, 0);
  const totalCost = mergedReadings.reduce((sum, r) => sum + r.cost, 0);
  console.log(`\nSummary:`);
  console.log(`  Total consumption: ${totalConsumption.toFixed(2)} kWh`);
  console.log(`  Total cost: $${totalCost.toFixed(2)}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
