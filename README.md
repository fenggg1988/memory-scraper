# Memory Price Scraper (DDR4 / DDR5)

每日追踪 **DDR4 / DDR5 桌面内存（DIMM）零售价格**，数据源为 [RamRadar RAM Price Index](https://ramradar.app/ram-price-index)（聚合自 eBay / Newegg / B&H Photo 的公开零售价，归一化为 **USD/GB**）。

## 为什么用 RamRadar 而不是 ZOL

原方案抓的是「中关村在线（ZOL）」国内电商价，但 ZOL 在 GitHub Actions 的**海外服务器上无法访问**（DNS 解析失败 / 被墙）。RamRadar 是美国站点、提供直接可下载的公开 CSV，海外服务器可正常抓取，且价格归一化为 `$/GB`，比整条模组的人民币价更可比。

## 数据来源

| 项目 | 说明 |
|---|---|
| 站点 | RamRadar RAM Price Index |
| 接口 | `https://ramradar.app/ram-price-index/data.csv`（无需 API key） |
| 口径 | 桌面 DIMM 的 DDR4 / DDR5，单位 USD/GB |
| 更新 | RamRadar 每日更新；本仓库每日 02:00 UTC（北京 10:00）自动拉取最新值 |

## 快速开始

```bash
# 立即抓取一次（需 Node 20+，无需安装依赖）
npm run scrape

# 打开仪表盘（数据已嵌入 HTML，不需要本地服务器）
# 直接双击 docs/index.html
```

## 每日自动抓取

通过 **GitHub Actions** 每日 02:00 UTC（北京时间 10:00）自动运行 `scraper.mjs`，
抓取结果汇总后提交回本仓库的 `data/ram_prices.csv` 与 `docs/`（JSON + 自包含 HTML 看板）。

## 文件结构

```
memory-scraper/
├── scraper.mjs              # 主脚本：下载 CSV → 解析 → 写数据 + 看板
├── data/ram_prices.csv      # 时序数据（date, source, category, avg/min/max_price, sample_count）
├── docs/
│   ├── ram_prices.json      # 时序数据 JSON
│   └── index.html           # 自包含 ECharts 仪表盘
└── .github/workflows/       # 每日自动运行配置
```

## 数据字段

`data/ram_prices.csv` 每行一条记录：

| 字段 | 含义 |
|---|---|
| `date` | 日期 YYYY-MM-DD |
| `source` | 固定 `ramradar` |
| `category` | `DDR4` 或 `DDR5` |
| `avg_price` / `min_price` / `max_price` | 当日 USD/GB 均价 / 最低 / 最高 |
| `sample_count` | 参与统计的在售模组数量 |

## 维护

- 脚本幂等：每次运行只追加 RamRadar CSV 中**尚不存在的日期**，重复运行不会产生重复数据
- 无需密钥、无需浏览器，CI 轻量稳定
