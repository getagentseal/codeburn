import type { SectionCatalog } from './types'

export const spend: SectionCatalog = {
  en: {
    'spend.provider.allModels': 'All models',

    'spend.punchcard.title': 'Spend punchcard',
    'spend.punchcard.right': 'hour of day × weekday',

    'spend.loading.scanning': 'Scanning spend…',

    'spend.chart.title': 'Daily spend by model',
    'spend.chart.empty': 'No model spend in this range yet.',

    'spend.flow.title': 'Cost flow · model → project',
    'spend.flow.right': 'model → project flow for this range',
    'spend.flow.loading': 'Loading cost flow…',
    'spend.flow.empty': 'No model-project flow in this range yet.',

    'spend.breakdown.activity': 'Activity',
    'spend.breakdown.tools': 'Tools',
    'spend.breakdown.mcp': 'MCP',
    'spend.breakdown.subagents': 'Subagents',
    'spend.breakdown.skillSuffix': '{turns} · skill',
    'spend.breakdown.emptyAll': 'No activity, tool, MCP, or subagent data in this range yet.',

    'spend.project.title': 'By project',
    'spend.project.top': 'top {count}',
    'spend.project.sessionsAria': '{name} sessions',
    'spend.project.viewSessions': 'View sessions for this project →',
    'spend.project.noDetail': 'No session detail for this project.',
    'spend.project.empty': 'No project spend in this range yet.',

    'spend.optimize.tabTitle.waste': 'Waste',
    'spend.optimize.tabTitle.reverts': 'Reverts',
    'spend.optimize.tabTitle.abandoned': 'Abandoned',
    'spend.optimize.tabTitle.fixes': 'Fixes',
    'spend.optimize.tabOption.waste': 'Waste {amount}',
    'spend.optimize.tabOption.reverts': 'Reverts {amount}',
    'spend.optimize.tabOption.abandoned': 'Abandoned {amount}',
    'spend.optimize.tabOption.fixes': 'Fixes {count}',

    'spend.optimize.loading.scanning': 'Scanning optimize findings…',
    'spend.optimize.waste.scanning': 'Scanning optimize findings…',
    'spend.optimize.waste.empty': 'No waste findings in this range yet.',
    'spend.optimize.waste.summary': '{count} · {savings} potential · health {health}/100',

    'spend.optimize.applied.header': 'Applied fixes',
    'spend.optimize.applied.estimate': 'est. {est} → {realized}',
    'spend.optimize.applied.hint': 'Revert one that did not help: ',

    'spend.optimize.verdict.worked': 'worked',
    'spend.optimize.verdict.partial': 'under estimate',
    'spend.optimize.verdict.noEffect': 'did not help',
    'spend.optimize.verdict.pending': 'measuring',

    'spend.optimize.class.fix': 'Fix now (apply-able)',
    'spend.optimize.finding.tokensBasis': '{tokens} tokens · {basis}',
    'spend.optimize.class.nudge': 'Habits',
    'spend.optimize.class.keep': 'FYI',
    'spend.optimize.class.summary': '{header} · {tokens} tokens · {savings} · {findings}',

    'spend.optimize.severity.high': 'High',
    'spend.optimize.severity.medium': 'Medium',
    'spend.optimize.severity.low': 'Low',

    'spend.optimize.trend.improving': 'improving',

    'spend.optimize.copy.label': 'Copy',
    'spend.optimize.copy.done': 'Copied',

    'spend.optimize.findingDetailsAria': '{title} details',

    'spend.optimize.reverts.empty': 'No reverted sessions in this range yet.',
    'spend.optimize.abandoned.empty': 'No abandoned sessions in this range yet.',
    'spend.optimize.fixes.empty': 'No fixes in this range yet.',

    'spend.optimize.yield.unavailable': 'Yield data is unavailable right now.',
    'spend.optimize.yield.commit.one': '{count} commit',
    'spend.optimize.yield.commit.other': '{count} commits',
  },
  fr: {
    'spend.provider.allModels': 'Tous les modèles',

    'spend.punchcard.title': 'Répartition horaire des dépenses',
    'spend.punchcard.right': 'heure de la journée × jour de la semaine',

    'spend.loading.scanning': 'Analyse des dépenses…',

    'spend.chart.title': 'Dépenses quotidiennes par modèle',
    'spend.chart.empty': 'Aucune dépense de modèle sur cette période.',

    'spend.flow.title': 'Flux des coûts · modèle → projet',
    'spend.flow.right': 'flux modèle → projet pour cette période',
    'spend.flow.loading': 'Chargement du flux des coûts…',
    'spend.flow.empty': 'Aucun flux modèle-projet sur cette période.',

    'spend.breakdown.activity': 'Activité',
    'spend.breakdown.tools': 'Outils',
    'spend.breakdown.mcp': 'MCP',
    'spend.breakdown.subagents': 'Sous-agents',
    'spend.breakdown.skillSuffix': '{turns} · compétence',
    'spend.breakdown.emptyAll': 'Aucune activité, outil, MCP ou sous-agent sur cette période.',

    'spend.project.title': 'Par projet',
    'spend.project.top': 'top {count}',
    'spend.project.sessionsAria': 'Sessions de {name}',
    'spend.project.viewSessions': 'Voir les sessions de ce projet →',
    'spend.project.noDetail': 'Aucun détail de session pour ce projet.',
    'spend.project.empty': 'Aucune dépense de projet sur cette période.',

    'spend.optimize.tabTitle.waste': 'Gaspillage',
    'spend.optimize.tabTitle.reverts': 'Annulations',
    'spend.optimize.tabTitle.abandoned': 'Abandonnées',
    'spend.optimize.tabTitle.fixes': 'Correctifs',
    'spend.optimize.tabOption.waste': 'Gaspillage {amount}',
    'spend.optimize.tabOption.reverts': 'Annulations {amount}',
    'spend.optimize.tabOption.abandoned': 'Abandonnées {amount}',
    'spend.optimize.tabOption.fixes': 'Correctifs {count}',

    'spend.optimize.loading.scanning': 'Analyse des résultats d’optimisation…',
    'spend.optimize.waste.scanning': 'Analyse des résultats d’optimisation…',
    'spend.optimize.waste.empty': 'Aucun gaspillage détecté sur cette période.',
    'spend.optimize.waste.summary': '{count} · {savings} potentiel · santé {health}/100',

    'spend.optimize.applied.header': 'Correctifs appliqués',
    'spend.optimize.applied.estimate': 'est. {est} → {realized}',
    'spend.optimize.applied.hint': 'Annuler un correctif inefficace : ',

    'spend.optimize.verdict.worked': 'efficace',
    'spend.optimize.verdict.partial': 'en dessous de l’estimation',
    'spend.optimize.verdict.noEffect': 'sans effet',
    'spend.optimize.verdict.pending': 'mesure en cours',

    'spend.optimize.class.fix': 'À corriger (applicable)',
    'spend.optimize.finding.tokensBasis': '{tokens} tokens · {basis}',
    'spend.optimize.class.nudge': 'Habitudes',
    'spend.optimize.class.keep': 'À noter',
    'spend.optimize.class.summary': '{header} · {tokens} tokens · {savings} · {findings}',

    'spend.optimize.severity.high': 'Élevé',
    'spend.optimize.severity.medium': 'Moyen',
    'spend.optimize.severity.low': 'Faible',

    'spend.optimize.trend.improving': 'en amélioration',

    'spend.optimize.copy.label': 'Copier',
    'spend.optimize.copy.done': 'Copié',

    'spend.optimize.findingDetailsAria': 'Détails de {title}',

    'spend.optimize.reverts.empty': 'Aucune session annulée sur cette période.',
    'spend.optimize.abandoned.empty': 'Aucune session abandonnée sur cette période.',
    'spend.optimize.fixes.empty': 'Aucun correctif sur cette période.',

    'spend.optimize.yield.unavailable': 'Les données de rendement sont indisponibles pour le moment.',
    'spend.optimize.yield.commit.one': '{count} commit',
    'spend.optimize.yield.commit.other': '{count} commits',
  },
  ja: {
    'spend.provider.allModels': 'すべてのモデル',

    'spend.punchcard.title': '支出パンチカード',
    'spend.punchcard.right': '時間帯 × 曜日',

    'spend.loading.scanning': '支出をスキャン中…',

    'spend.chart.title': 'モデル別の日次支出',
    'spend.chart.empty': 'この期間のモデル支出はまだありません。',

    'spend.flow.title': 'コストフロー・モデル→プロジェクト',
    'spend.flow.right': 'この期間のモデル→プロジェクトのフロー',
    'spend.flow.loading': 'コストフローを読み込み中…',
    'spend.flow.empty': 'この期間のモデル-プロジェクトフローはまだありません。',

    'spend.breakdown.activity': 'アクティビティ',
    'spend.breakdown.tools': 'ツール',
    'spend.breakdown.mcp': 'MCP',
    'spend.breakdown.subagents': 'サブエージェント',
    'spend.breakdown.skillSuffix': '{turns} ・ スキル',
    'spend.breakdown.emptyAll': 'この期間のアクティビティ、ツール、MCP、サブエージェントのデータはまだありません。',

    'spend.project.title': 'プロジェクト別',
    'spend.project.top': '上位{count}件',
    'spend.project.sessionsAria': '{name}のセッション',
    'spend.project.viewSessions': 'このプロジェクトのセッションを表示 →',
    'spend.project.noDetail': 'このプロジェクトのセッション詳細はありません。',
    'spend.project.empty': 'この期間のプロジェクト支出はまだありません。',

    'spend.optimize.tabTitle.waste': '無駄',
    'spend.optimize.tabTitle.reverts': '差し戻し',
    'spend.optimize.tabTitle.abandoned': '放棄',
    'spend.optimize.tabTitle.fixes': '修正',
    'spend.optimize.tabOption.waste': '無駄 {amount}',
    'spend.optimize.tabOption.reverts': '差し戻し {amount}',
    'spend.optimize.tabOption.abandoned': '放棄 {amount}',
    'spend.optimize.tabOption.fixes': '修正 {count}',

    'spend.optimize.loading.scanning': '最適化結果をスキャン中…',
    'spend.optimize.waste.scanning': '最適化結果をスキャン中…',
    'spend.optimize.waste.empty': 'この期間の無駄はまだ見つかっていません。',
    'spend.optimize.waste.summary': '{count} ・ {savings} 見込み ・ 健全性 {health}/100',

    'spend.optimize.applied.header': '適用済みの修正',
    'spend.optimize.applied.estimate': '見積り {est} → 実測 {realized}',
    'spend.optimize.applied.hint': '効果がなかったものを元に戻す: ',

    'spend.optimize.verdict.worked': '効果あり',
    'spend.optimize.verdict.partial': '見積り未達',
    'spend.optimize.verdict.noEffect': '効果なし',
    'spend.optimize.verdict.pending': '測定中',

    'spend.optimize.class.fix': '今すぐ修正(適用可能)',
    'spend.optimize.finding.tokensBasis': '{tokens}トークン ・ {basis}',
    'spend.optimize.class.nudge': '習慣',
    'spend.optimize.class.keep': '参考情報',
    'spend.optimize.class.summary': '{header} ・ {tokens}トークン ・ {savings} ・ {findings}',

    'spend.optimize.severity.high': '高',
    'spend.optimize.severity.medium': '中',
    'spend.optimize.severity.low': '低',

    'spend.optimize.trend.improving': '改善中',

    'spend.optimize.copy.label': 'コピー',
    'spend.optimize.copy.done': 'コピー済み',

    'spend.optimize.findingDetailsAria': '{title}の詳細',

    'spend.optimize.reverts.empty': 'この期間に差し戻されたセッションはありません。',
    'spend.optimize.abandoned.empty': 'この期間に放棄されたセッションはありません。',
    'spend.optimize.fixes.empty': 'この期間の修正はまだありません。',

    'spend.optimize.yield.unavailable': '現在、成果データは利用できません。',
    'spend.optimize.yield.commit.one': '{count}件のコミット',
    'spend.optimize.yield.commit.other': '{count}件のコミット',
  },
  ko: {
    'spend.provider.allModels': '모든 모델',

    'spend.punchcard.title': '지출 펀치카드',
    'spend.punchcard.right': '시간대 × 요일',

    'spend.loading.scanning': '지출 스캔 중…',

    'spend.chart.title': '모델별 일별 지출',
    'spend.chart.empty': '이 기간의 모델 지출이 아직 없습니다.',

    'spend.flow.title': '비용 흐름 · 모델 → 프로젝트',
    'spend.flow.right': '이 기간의 모델 → 프로젝트 흐름',
    'spend.flow.loading': '비용 흐름 불러오는 중…',
    'spend.flow.empty': '이 기간에 모델-프로젝트 흐름이 없습니다.',

    'spend.breakdown.activity': '활동',
    'spend.breakdown.tools': '도구',
    'spend.breakdown.mcp': 'MCP',
    'spend.breakdown.subagents': '서브에이전트',
    'spend.breakdown.skillSuffix': '{turns} · 스킬',
    'spend.breakdown.emptyAll': '이 기간의 활동, 도구, MCP, 서브에이전트 데이터가 아직 없습니다.',

    'spend.project.title': '프로젝트별',
    'spend.project.top': '상위 {count}개',
    'spend.project.sessionsAria': '{name}의 세션',
    'spend.project.viewSessions': '이 프로젝트의 세션 보기 →',
    'spend.project.noDetail': '이 프로젝트의 세션 상세 정보가 없습니다.',
    'spend.project.empty': '이 기간의 프로젝트 지출이 아직 없습니다.',

    'spend.optimize.tabTitle.waste': '낭비',
    'spend.optimize.tabTitle.reverts': '되돌림',
    'spend.optimize.tabTitle.abandoned': '중단됨',
    'spend.optimize.tabTitle.fixes': '수정',
    'spend.optimize.tabOption.waste': '낭비 {amount}',
    'spend.optimize.tabOption.reverts': '되돌림 {amount}',
    'spend.optimize.tabOption.abandoned': '중단됨 {amount}',
    'spend.optimize.tabOption.fixes': '수정 {count}',

    'spend.optimize.loading.scanning': '최적화 결과 스캔 중…',
    'spend.optimize.waste.scanning': '최적화 결과 스캔 중…',
    'spend.optimize.waste.empty': '이 기간에 낭비 결과가 아직 없습니다.',
    'spend.optimize.waste.summary': '{count} · {savings} 잠재 절감 · 상태 {health}/100',

    'spend.optimize.applied.header': '적용된 수정',
    'spend.optimize.applied.estimate': '예상 {est} → 실제 {realized}',
    'spend.optimize.applied.hint': '도움이 되지 않은 항목 되돌리기: ',

    'spend.optimize.verdict.worked': '효과 있음',
    'spend.optimize.verdict.partial': '예상 미달',
    'spend.optimize.verdict.noEffect': '효과 없음',
    'spend.optimize.verdict.pending': '측정 중',

    'spend.optimize.class.fix': '지금 수정(적용 가능)',
    'spend.optimize.finding.tokensBasis': '{tokens} 토큰 · {basis}',
    'spend.optimize.class.nudge': '습관',
    'spend.optimize.class.keep': '참고',
    'spend.optimize.class.summary': '{header} · {tokens} 토큰 · {savings} · {findings}',

    'spend.optimize.severity.high': '높음',
    'spend.optimize.severity.medium': '보통',
    'spend.optimize.severity.low': '낮음',

    'spend.optimize.trend.improving': '개선 중',

    'spend.optimize.copy.label': '복사',
    'spend.optimize.copy.done': '복사됨',

    'spend.optimize.findingDetailsAria': '{title} 세부 정보',

    'spend.optimize.reverts.empty': '이 기간에 되돌려진 세션이 없습니다.',
    'spend.optimize.abandoned.empty': '이 기간에 중단된 세션이 없습니다.',
    'spend.optimize.fixes.empty': '이 기간의 수정 사항이 아직 없습니다.',

    'spend.optimize.yield.unavailable': '현재 수익 데이터를 사용할 수 없습니다.',
    'spend.optimize.yield.commit.one': '커밋 {count}개',
    'spend.optimize.yield.commit.other': '커밋 {count}개',
  },
  zhCN: {
    'spend.provider.allModels': '所有模型',

    'spend.punchcard.title': '支出打卡表',
    'spend.punchcard.right': '时段 × 星期',

    'spend.loading.scanning': '正在扫描支出…',

    'spend.chart.title': '按模型划分的每日支出',
    'spend.chart.empty': '此期间尚无模型支出。',

    'spend.flow.title': '成本流向 · 模型 → 项目',
    'spend.flow.right': '此期间的模型 → 项目流向',
    'spend.flow.loading': '正在加载成本流向…',
    'spend.flow.empty': '此期间尚无模型-项目流向数据。',

    'spend.breakdown.activity': '活动',
    'spend.breakdown.tools': '工具',
    'spend.breakdown.mcp': 'MCP',
    'spend.breakdown.subagents': '子代理',
    'spend.breakdown.skillSuffix': '{turns} · 技能',
    'spend.breakdown.emptyAll': '此期间尚无活动、工具、MCP 或子代理数据。',

    'spend.project.title': '按项目',
    'spend.project.top': '前 {count} 名',
    'spend.project.sessionsAria': '{name} 的会话',
    'spend.project.viewSessions': '查看此项目的会话 →',
    'spend.project.noDetail': '此项目没有会话详情。',
    'spend.project.empty': '此期间尚无项目支出。',

    'spend.optimize.tabTitle.waste': '浪费',
    'spend.optimize.tabTitle.reverts': '已回退',
    'spend.optimize.tabTitle.abandoned': '已放弃',
    'spend.optimize.tabTitle.fixes': '修复',
    'spend.optimize.tabOption.waste': '浪费 {amount}',
    'spend.optimize.tabOption.reverts': '已回退 {amount}',
    'spend.optimize.tabOption.abandoned': '已放弃 {amount}',
    'spend.optimize.tabOption.fixes': '修复 {count}',

    'spend.optimize.loading.scanning': '正在扫描优化结果…',
    'spend.optimize.waste.scanning': '正在扫描优化结果…',
    'spend.optimize.waste.empty': '此期间尚未发现浪费。',
    'spend.optimize.waste.summary': '{count} · 预计可省 {savings} · 健康度 {health}/100',

    'spend.optimize.applied.header': '已应用的修复',
    'spend.optimize.applied.estimate': '预计 {est} → 实际 {realized}',
    'spend.optimize.applied.hint': '撤销一个无效的修复: ',

    'spend.optimize.verdict.worked': '有效',
    'spend.optimize.verdict.partial': '低于预期',
    'spend.optimize.verdict.noEffect': '无效果',
    'spend.optimize.verdict.pending': '测量中',

    'spend.optimize.class.fix': '立即修复(可应用)',
    'spend.optimize.finding.tokensBasis': '{tokens} token · {basis}',
    'spend.optimize.class.nudge': '习惯',
    'spend.optimize.class.keep': '仅供参考',
    'spend.optimize.class.summary': '{header} · {tokens} token · {savings} · {findings}',

    'spend.optimize.severity.high': '高',
    'spend.optimize.severity.medium': '中',
    'spend.optimize.severity.low': '低',

    'spend.optimize.trend.improving': '正在改善',

    'spend.optimize.copy.label': '复制',
    'spend.optimize.copy.done': '已复制',

    'spend.optimize.findingDetailsAria': '{title}详情',

    'spend.optimize.reverts.empty': '此期间没有回退的会话。',
    'spend.optimize.abandoned.empty': '此期间没有放弃的会话。',
    'spend.optimize.fixes.empty': '此期间尚无修复。',

    'spend.optimize.yield.unavailable': '产出数据目前不可用。',
    'spend.optimize.yield.commit.one': '{count} 次提交',
    'spend.optimize.yield.commit.other': '{count} 次提交',
  },
  zhTW: {
    'spend.provider.allModels': '所有模型',

    'spend.punchcard.title': '支出打卡表',
    'spend.punchcard.right': '時段 × 星期',

    'spend.loading.scanning': '正在掃描支出…',

    'spend.chart.title': '按模型劃分的每日支出',
    'spend.chart.empty': '此期間尚無模型支出。',

    'spend.flow.title': '成本流向 · 模型 → 專案',
    'spend.flow.right': '此期間的模型 → 專案流向',
    'spend.flow.loading': '正在載入成本流向…',
    'spend.flow.empty': '此期間尚無模型-專案流向資料。',

    'spend.breakdown.activity': '活動',
    'spend.breakdown.tools': '工具',
    'spend.breakdown.mcp': 'MCP',
    'spend.breakdown.subagents': '子代理',
    'spend.breakdown.skillSuffix': '{turns} · 技能',
    'spend.breakdown.emptyAll': '此期間尚無活動、工具、MCP 或子代理資料。',

    'spend.project.title': '依專案',
    'spend.project.top': '前 {count} 名',
    'spend.project.sessionsAria': '{name} 的工作階段',
    'spend.project.viewSessions': '查看此專案的工作階段 →',
    'spend.project.noDetail': '此專案沒有工作階段詳情。',
    'spend.project.empty': '此期間尚無專案支出。',

    'spend.optimize.tabTitle.waste': '浪費',
    'spend.optimize.tabTitle.reverts': '已回退',
    'spend.optimize.tabTitle.abandoned': '已放棄',
    'spend.optimize.tabTitle.fixes': '修復',
    'spend.optimize.tabOption.waste': '浪費 {amount}',
    'spend.optimize.tabOption.reverts': '已回退 {amount}',
    'spend.optimize.tabOption.abandoned': '已放棄 {amount}',
    'spend.optimize.tabOption.fixes': '修復 {count}',

    'spend.optimize.loading.scanning': '正在掃描最佳化結果…',
    'spend.optimize.waste.scanning': '正在掃描最佳化結果…',
    'spend.optimize.waste.empty': '此期間尚未發現浪費。',
    'spend.optimize.waste.summary': '{count} · 預計可省 {savings} · 健康度 {health}/100',

    'spend.optimize.applied.header': '已套用的修復',
    'spend.optimize.applied.estimate': '預計 {est} → 實際 {realized}',
    'spend.optimize.applied.hint': '撤銷一個無效的修復: ',

    'spend.optimize.verdict.worked': '有效',
    'spend.optimize.verdict.partial': '低於預期',
    'spend.optimize.verdict.noEffect': '無效果',
    'spend.optimize.verdict.pending': '測量中',

    'spend.optimize.class.fix': '立即修復(可套用)',
    'spend.optimize.finding.tokensBasis': '{tokens} token · {basis}',
    'spend.optimize.class.nudge': '習慣',
    'spend.optimize.class.keep': '僅供參考',
    'spend.optimize.class.summary': '{header} · {tokens} token · {savings} · {findings}',

    'spend.optimize.severity.high': '高',
    'spend.optimize.severity.medium': '中',
    'spend.optimize.severity.low': '低',

    'spend.optimize.trend.improving': '正在改善',

    'spend.optimize.copy.label': '複製',
    'spend.optimize.copy.done': '已複製',

    'spend.optimize.findingDetailsAria': '{title}詳情',

    'spend.optimize.reverts.empty': '此期間沒有回退的工作階段。',
    'spend.optimize.abandoned.empty': '此期間沒有放棄的工作階段。',
    'spend.optimize.fixes.empty': '此期間尚無修復。',

    'spend.optimize.yield.unavailable': '目前無法取得產出資料。',
    'spend.optimize.yield.commit.one': '{count} 次提交',
    'spend.optimize.yield.commit.other': '{count} 次提交',
  },
}
