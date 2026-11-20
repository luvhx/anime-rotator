#!/usr/bin/env node
/**
 * TMDB 索引与筛选自检（不联网，用假客户/假数据）
 *   node tools/selftest-tmdb.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TmdbIndex } from '../src/tmdb-index.mjs';

let fails = 0;
const check = (ok, msg, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmdb-idx-'));
const file = path.join(tmp, 'index.json');

const series = [
  { id: 's1', displayName: '冰菓', name: '冰菓' },
  { id: 's2', displayName: '86-不存在的战区', name: '86-不存在的战区' },
  { id: 's3', displayName: '某个没有匹配的', name: '某个没有匹配的' },
  { id: 's4', displayName: '目录里带 TMDB 标签', name: '带标签 {tmdb-9999}' , tmdbId: 9999 },
];

/* ---------- 假 TMDB 客户端 ---------- */
const fakeTmdb = {
  enabled: true,
  dirty: false,
  async matchSeries(name) {
    // 真实搜索结果就带年份/评分/类型，索引同步不再额外请求详情
    if (name.includes('冰菓')) return { status: 'matched', best: { id: 1001, name: '冰菓', year: '2012', vote: 8.2, genres: ['动画', '悬疑'], overview: '', poster: null, score: 0.9 } };
    if (name.includes('86')) return { status: 'matched', best: { id: 1002, name: '86', year: '2021', vote: 7.9, genres: ['动画', '科幻'], overview: '', poster: null, score: 0.8 } };
    return { status: 'none' };
  },
  async tvDetails(id) {
    const base = {
      1001: { name: '冰菓', year: '2012', vote: 8.2, genres: ['动画', '悬疑'], status: 'Ended' },
      1002: { name: '86', year: '2021', vote: 7.9, genres: ['动画', '科幻'], status: 'Ended' },
      9999: { name: '标签剧', year: '1999', vote: 9.1, genres: ['动画', '经典'], status: 'Ended' },
    }[id];
    if (!base) return null;
    return { id, ...base, originalName: base.name, overview: '', poster: null, numberOfSeasons: 1, numberOfEpisodes: 12 };
  },
};

const idx = new TmdbIndex({ file, tmdb: fakeTmdb });

/* ---------- 同步 ---------- */
const res = await idx.syncAll(series, { concurrency: 2 });
check(res.done === 4, '同步全部剧集', `${res.done}/${res.total}`);
check(idx.get('s1')?.year === '2012' && idx.get('s1')?.genres.includes('动画'), '写入年份与类型');
check(idx.get('s3')?.tmdbId === null, '未匹配的也要记录（避免反复查询）');
check(idx.get('s4')?.genres?.includes('经典'), '带标签的走详情接口', JSON.stringify(idx.get('s4')?.genres || []));

/* ---------- 持久化 ---------- */
idx.save();
const idx2 = new TmdbIndex({ file, tmdb: fakeTmdb });
check(idx2.get('s1')?.tmdbId === 1001, '索引可持久化并重新加载');

/* ---------- 筛选 ---------- */
const byYear = idx2.filterSeries(series, { yearFrom: 2015 });
check(byYear.map((s) => s.id).join(',') === 's2', '按年份筛选', byYear.map((s) => s.displayName).join(',') || '(空)');

const byGenre = idx2.filterSeries(series, { genres: ['科幻'] });
check(byGenre.map((s) => s.id).join(',') === 's2', '按类型筛选', byGenre.map((s) => s.displayName).join(','));

const byVote = idx2.filterSeries(series, { minVote: 8 });
check(byVote.map((s) => s.id).sort().join(',') === 's1,s4', '按评分筛选', byVote.map((s) => s.displayName).join(','));

const requireMatch = idx2.filterSeries(series, { requireMatch: true });
check(requireMatch.length === 3, '只看已匹配的', `${requireMatch.length} 部`);

const combo = idx2.filterSeries(series, { yearFrom: 2010, yearTo: 2020, genres: ['悬疑'], minVote: 8 });
check(combo.map((s) => s.id).join(',') === 's1', '多条件组合筛选', combo.map((s) => s.displayName).join(','));

const none = idx2.filterSeries(series, { yearFrom: 2030 });
check(none.length === 0, '条件不命中时返回空');

const noFilter = idx2.filterSeries(series, {});
check(noFilter.length === 4, '无条件时返回全部');

/* ---------- 统计 ---------- */
const facets = idx2.facets(series);
check(facets.matched === 3 && facets.unmatched === 1, 'facets 匹配统计', JSON.stringify({ matched: facets.matched, unmatched: facets.unmatched }));
const anime = facets.genres.find((g) => g.name === '动画');
check(anime?.count === 3, 'facets 类型计数', `动画 ${anime?.count}`);
check(facets.years.some((y) => y.year === '2021'), 'facets 年份列表');
check(idx2.stats(4).matched === 3, 'stats 汇总');

/* ---------- 过期 ---------- */
const stale = new TmdbIndex({ file, tmdb: fakeTmdb, ttlMs: -1 });
check(stale.isStale('s1'), 'TTL 过期判定');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails === 0 ? '\nTMDB 索引自检通过 ✓' : `\n${fails} 项失败 ✗`);
process.exit(fails ? 1 : 0);
