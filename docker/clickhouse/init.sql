-- ClickHouse 事件域 DDL v2（M7.5 P2）：按 kind 分表替代 M4 单宽表
-- 职责铁律（ADR-4）：CH 只存 append-only 事件事实；可变状态归 Postgres。
-- 明细完整性（P2 验收）：behavior_events 完整保留事件名/属性/PV 来源（UTM）/停留时长，
-- api_events 完整保留 method/url/status/duration/trace_id——M8 访问域与 M9 埋点分析依赖。
-- 键维度注记：沿用 apikey（public_key 与 project_id 一一对应）；随 P3 权限分离再评估
-- 是否重键 project_id（见 CURRENT M7.5 P2 记录）。
-- 存量部署注记：v1 单宽表 events 不再创建；存量数据需迁移或重建卷。

CREATE TABLE IF NOT EXISTS error_events
(
    ts            DateTime          COMMENT '客户端事件时间',
    apikey        LowCardinality(String),
    type          LowCardinality(String) COMMENT '错误 9 分类（js/promise/resource/ajax/white_screen 等）',
    resource_kind LowCardinality(String) DEFAULT '' COMMENT '资源错误细分 script/image/css/media/other',
    release       LowCardinality(String) DEFAULT '',
    env           LowCardinality(String) DEFAULT '',
    sdkName       LowCardinality(String) DEFAULT '',
    sdkVersion    LowCardinality(String) DEFAULT '',
    sessionId     String            DEFAULT '',
    trackerId     String            DEFAULT '',
    page          String            DEFAULT '',
    viewId        String            DEFAULT '',
    device        String            DEFAULT '{}' COMMENT '设备快照 JSON',
    errorName     String            DEFAULT '',
    errorLevel    String            DEFAULT '',
    errorId       String            DEFAULT '' COMMENT 'SDK 流量去重指纹（message 级）',
    fingerprint   String            DEFAULT '' COMMENT '服务端分析指纹（含首帧位置）',
    componentName String            DEFAULT '',
    message       String            DEFAULT '' COMMENT '全量 message（详情页展示）',
    message_head  String            DEFAULT '' COMMENT 'message 前 128 字符（指纹分组冗余列）',
    stack_frames  String            DEFAULT '[]' COMMENT 'JSON',
    http          String            DEFAULT '' COMMENT 'HTTP 上下文 JSON',
    breadcrumbs   String            DEFAULT '[]' COMMENT 'JSON'
)
    ENGINE = MergeTree
    PARTITION BY toYYYYMM(ts)
    ORDER BY (apikey, type, fingerprint, ts)
    TTL toDateTime(ts) + INTERVAL 90 DAY;

-- 错误组物化视图：按指纹聚合（增量维护，查询 O(组数)）
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
FROM error_events
WHERE fingerprint != ''
GROUP BY apikey, fingerprint, type;

CREATE TABLE IF NOT EXISTS perf_events
(
    ts            DateTime,
    apikey        LowCardinality(String),
    release       LowCardinality(String) DEFAULT '',
    env           LowCardinality(String) DEFAULT '',
    sdkName       LowCardinality(String) DEFAULT '',
    sdkVersion    LowCardinality(String) DEFAULT '',
    sessionId     String            DEFAULT '',
    trackerId     String            DEFAULT '',
    page          String            DEFAULT '',
    viewId        String            DEFAULT '',
    device        String            DEFAULT '{}',
    metric_name   LowCardinality(String),
    metric_value  Float32,
    metric_score  Float32           DEFAULT 0,
    metric_detail String            DEFAULT '' COMMENT '富信息 JSON（NT/RT 分阶段等）'
)
    ENGINE = MergeTree
    PARTITION BY toYYYYMM(ts)
    ORDER BY (apikey, metric_name, ts)
    TTL toDateTime(ts) + INTERVAL 90 DAY;

-- 性能分位物化视图：quantilesTDigest 状态按 小时×发版×指标（发版对比的基础视图）。
-- 多分位必须用 quantilesTDigest 家族——quantileTDigest 只接受单个 level（24.8 实测）。
CREATE TABLE IF NOT EXISTS perf_stats_mv
(
    hour        DateTime,
    apikey      LowCardinality(String),
    release     LowCardinality(String),
    metric_name LowCardinality(String),
    quantiles   AggregateFunction(quantilesTDigest(0.5, 0.75, 0.95), Float32),
    count       SimpleAggregateFunction(sum, UInt64)
)
    ENGINE = AggregatingMergeTree
    ORDER BY (apikey, release, metric_name, hour);

CREATE MATERIALIZED VIEW IF NOT EXISTS perf_stats_view
    TO perf_stats_mv
AS
SELECT toStartOfHour(ts)                                 AS hour,
       apikey,
       release,
       metric_name,
       quantilesTDigestState(0.5, 0.75, 0.95)(metric_value) AS quantiles,
       count()                                          AS count
FROM perf_events
GROUP BY apikey, release, metric_name, hour;

CREATE TABLE IF NOT EXISTS behavior_events
(
    ts            DateTime,
    apikey        LowCardinality(String),
    release       LowCardinality(String) DEFAULT '',
    env           LowCardinality(String) DEFAULT '',
    sdkName       LowCardinality(String) DEFAULT '',
    sdkVersion    LowCardinality(String) DEFAULT '',
    sessionId     String            DEFAULT '',
    trackerId     String            DEFAULT '',
    page          String            DEFAULT '',
    viewId        String            DEFAULT '',
    device        String            DEFAULT '{}',
    behavior_type LowCardinality(String) COMMENT 'page_view / page_dwell / expose / track',
    name          LowCardinality(String) DEFAULT '' COMMENT 'track / expose 事件名',
    props         String            DEFAULT '' COMMENT 'track 属性 JSON',
    url           String            DEFAULT '' COMMENT 'PV 页面路径（出口已剥 query）',
    load_type     LowCardinality(String) DEFAULT '' COMMENT 'navigate / reload / back_forward',
    referrer_host String            DEFAULT '' COMMENT 'PV 来源站（会话首 PV）',
    utm_source    String            DEFAULT '',
    utm_medium    String            DEFAULT '',
    utm_campaign  String            DEFAULT '',
    selector      String            DEFAULT '' COMMENT 'expose 选择器',
    dwell_ms      UInt32            DEFAULT 0 COMMENT 'page_dwell 可见时长 / expose 停留阈值',
    from_source   LowCardinality(String) DEFAULT '' COMMENT 'track 来源 api / declarative'
)
    ENGINE = MergeTree
    PARTITION BY toYYYYMM(ts)
    ORDER BY (apikey, behavior_type, ts)
    TTL toDateTime(ts) + INTERVAL 90 DAY;

-- PV 小时桶：PV 计数 + trackerId UV 状态（M8 访问视图直读；sessionId 仅用于会话数）
CREATE TABLE IF NOT EXISTS pv_stats_mv
(
    hour   DateTime,
    apikey LowCardinality(String),
    pv     SimpleAggregateFunction(sum, UInt64),
    uv     AggregateFunction(uniq, String)
)
    ENGINE = AggregatingMergeTree
    ORDER BY (apikey, hour);

CREATE MATERIALIZED VIEW IF NOT EXISTS pv_stats_view
    TO pv_stats_mv
AS
SELECT toStartOfHour(ts) AS hour,
       apikey,
       count()            AS pv,
       uniqState(trackerId) AS uv
FROM behavior_events
WHERE behavior_type = 'page_view'
GROUP BY apikey, hour;

CREATE TABLE IF NOT EXISTS api_events
(
    ts         DateTime,
    apikey     LowCardinality(String),
    release    LowCardinality(String) DEFAULT '',
    env        LowCardinality(String) DEFAULT '',
    sdkName    LowCardinality(String) DEFAULT '',
    sdkVersion LowCardinality(String) DEFAULT '',
    sessionId  String            DEFAULT '',
    trackerId  String            DEFAULT '',
    page       String            DEFAULT '',
    viewId     String            DEFAULT '',
    device     String            DEFAULT '{}',
    method     LowCardinality(String) DEFAULT '',
    url        String            DEFAULT '' COMMENT '出口已剥 query（聚合按路径语义）',
    status     UInt16            DEFAULT 0,
    duration_ms UInt32           DEFAULT 0,
    is_slow    UInt8             DEFAULT 0,
    trace_id   String            DEFAULT '' COMMENT '标识键，脱敏白名单（链路串联）'
    -- 采样率列随 M8 协议加性扩展加入（服务端不知 SDK 侧 apiSampleRate，先不给假值）
)
    ENGINE = MergeTree
    PARTITION BY toYYYYMM(ts)
    ORDER BY (apikey, url, ts)
    TTL toDateTime(ts) + INTERVAL 30 DAY;

-- API 小时桶：计数 + 可合并分位状态（调用量/成功率/分位的基础视图；M8 按采样率校正）
CREATE TABLE IF NOT EXISTS api_stats_mv
(
    hour      DateTime,
    apikey    LowCardinality(String),
    count     SimpleAggregateFunction(sum, UInt64),
    durations AggregateFunction(quantilesTDigest(0.5, 0.75, 0.95), UInt32)
)
    ENGINE = AggregatingMergeTree
    ORDER BY (apikey, hour);

CREATE MATERIALIZED VIEW IF NOT EXISTS api_stats_view
    TO api_stats_mv
AS
SELECT toStartOfHour(ts)                              AS hour,
       apikey,
       count()                                        AS count,
       quantilesTDigestState(0.5, 0.75, 0.95)(duration_ms) AS durations
FROM api_events
GROUP BY apikey, hour;
