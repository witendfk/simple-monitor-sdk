-- events：明细事件表（总纲 §6.3）
-- perf 指标 unwind 后一行一指标；错误一行一事件
CREATE TABLE IF NOT EXISTS events
(
    ts            DateTime          COMMENT '客户端事件时间',
    apikey        LowCardinality(String),
    kind          LowCardinality(String) COMMENT 'error | perf | replay',
    type          LowCardinality(String) COMMENT '错误类型或指标名',
    release       LowCardinality(String) COMMENT '发版标识（发版对比维度）',
    env           LowCardinality(String),
    sdkName       LowCardinality(String),
    sdkVersion    LowCardinality(String),
    sessionId     String            COMMENT '会话（30min 窗口分析主键）',
    trackerId     String            COMMENT '用户标识',
    page          String,
    viewId        String            COMMENT 'SPA 路由视图',
    device        String            COMMENT '设备快照 JSON',
    errorMessage  String DEFAULT '',
    errorName     String DEFAULT '',
    errorLevel    String DEFAULT '',
    errorId       String DEFAULT '' COMMENT 'SDK 流量去重指纹（message 级）',
    fingerprint   String DEFAULT '' COMMENT '服务端分析指纹（含首帧位置）',
    componentName String DEFAULT '',
    stackFrames   String DEFAULT '[]',
    http          String DEFAULT '',
    metricName    LowCardinality(String) DEFAULT '',
    metricValue   Float32,
    metricScore   String DEFAULT '',
    metricDetail  String DEFAULT '',
    breadcrumbs   String DEFAULT '[]'
)
    ENGINE = MergeTree
    PARTITION BY toYYYYMM(ts)
    ORDER BY (apikey, kind, type, ts)
    TTL toDateTime(ts) + INTERVAL 30 DAY
    COMMENT '明细事件（TTL 30 天，聚合结论见下）';

-- 错误组实时物化视图：按指纹聚合（增量维护，查询 O(组数) 而非 O(明细)）
CREATE TABLE IF NOT EXISTS error_groups_mv
(
    apikey           LowCardinality(String),
    fingerprint      String,
    type             LowCardinality(String),
    count            SimpleAggregateFunction(sum, UInt64),
    affectedSessions AggregateFunction(uniqExact, String),
    firstSeen        SimpleAggregateFunction(min, DateTime),
    lastSeen         SimpleAggregateFunction(max, DateTime)
)
    ENGINE = AggregatingMergeTree
    ORDER BY (apikey, fingerprint);

CREATE MATERIALIZED VIEW IF NOT EXISTS error_groups_view
    TO error_groups_mv
AS
SELECT apikey,
       fingerprint,
       type,
       count()                                                AS count,
       uniqExactState(sessionId)                              AS affectedSessions,
       min(ts)                                                AS firstSeen,
       max(ts)                                                AS lastSeen
FROM events
WHERE kind = 'error' AND fingerprint != ''
GROUP BY apikey, fingerprint, type;

-- 性能分位物化视图：quantileTDigest 状态按 小时×指标 聚合（发版对比查询直读）
CREATE TABLE IF NOT EXISTS perf_stats_mv
(
    hour          DateTime,
    apikey        LowCardinality(String),
    metricName    LowCardinality(String),
    quantiles     AggregateFunction(quantileTDigest(0.5, 0.75, 0.95), Float32),
    count         SimpleAggregateFunction(sum, UInt64)
)
    ENGINE = AggregatingMergeTree
    ORDER BY (apikey, metricName, hour);

CREATE MATERIALIZED VIEW IF NOT EXISTS perf_stats_view
    TO perf_stats_mv
AS
SELECT toStartOfHour(ts)                              AS hour,
       apikey,
       metricName,
       quantileTDigestState(0.5, 0.75, 0.95)(metricValue) AS quantiles,
       count()                                        AS count
FROM events
WHERE kind = 'perf'
GROUP BY apikey, metricName, hour;
