/**
 * Russian translation of funnel CONTENT (texts that come from funnel configs).
 *
 * The configs are the customer's files and must not be edited, so translations live here, keyed by the original
 * English text (gettext-style msgid). Consequences:
 *  - a text missing here is shown in the original language — nothing breaks;
 *  - the same text in another version or variant is translated automatically;
 *  - scripts/test/i18n.test.ts fails if any text of funnel-v1/v2/v3.json has no translation.
 */
export const contentRu: Record<string, string> = {
  // ---- intro (A) ----
  'Team operating-style check': 'Проверка стиля работы команды',
  'Build a work model your team can actually follow': 'Постройте модель работы, которой команда действительно будет следовать',
  'Answer a few questions and get a fictional recommendation for this technical exercise.':
    'Ответьте на несколько вопросов и получите вымышленную рекомендацию для этого тестового задания.',
  Start: 'Начать',
  // ---- intro (B, v1 / v2 / v3) ----
  '2-minute team check': 'Проверка команды за 2 минуты',
  'How should your team really work?': 'Как на самом деле стоит работать вашей команде?',
  'Answer a few questions to get a practical operating-style recommendation.':
    'Ответьте на несколько вопросов и получите практическую рекомендацию по стилю работы.',
  'Show me': 'Показать',
  '2-minute operating check': 'Проверка работы команды за 2 минуты',
  '90-second operating check': 'Проверка работы команды за 90 секунд',
  'Is your team losing time to the way it works?': 'Теряет ли ваша команда время из-за того, как она работает?',
  'Answer a few questions to get a practical, fictional operating-style recommendation.':
    'Ответьте на несколько вопросов и получите практическую (вымышленную) рекомендацию по стилю работы.',
  'Check our setup': 'Проверить нашу команду',

  // ---- team_size ----
  'How many people are on the team?': 'Сколько человек в команде?',
  'Include regular contractors who join team rituals.': 'Учитывайте постоянных подрядчиков, которые участвуют в командных встречах.',
  people: 'чел.',
  'Enter the team size.': 'Укажите размер команды.',
  'The team must have at least one person.': 'В команде должен быть хотя бы один человек.',
  'For this demo, enter a value up to 200.': 'В этой демоверсии — не больше 200.',

  // ---- work_mode ----
  'Where does the team work most of the time?': 'Где команда работает большую часть времени?',
  'Choose the closest option.': 'Выберите наиболее близкий вариант.',
  'Fully remote': 'Полностью удалённо',
  Hybrid: 'Гибридно',
  'Mostly in the office': 'В основном в офисе',
  "Select the team's main work mode.": 'Выберите основной формат работы команды.',

  // ---- priorities ----
  'What should the operating model improve?': 'Что должна улучшить модель работы?',
  'Choose between one and three priorities.': 'Выберите от одного до трёх приоритетов.',
  'What would make the biggest difference right now?': 'Что дало бы самый большой эффект прямо сейчас?',
  'Choose up to three outcomes.': 'Выберите до трёх результатов.',
  'What is the most urgent operating constraint?': 'Какое ограничение в работе самое срочное?',
  'Choose up to three. Some answers may open a follow-up question.': 'Выберите до трёх. Некоторые ответы откроют уточняющий вопрос.',
  'Decision speed': 'Скорость принятия решений',
  'Deep-focus time': 'Время для глубокой работы',
  'Team connection': 'Сплочённость команды',
  'Lower operating cost': 'Меньше операционных расходов',
  'Faster onboarding': 'Быстрее вводить новичков',
  'Compliance and access control': 'Комплаенс и контроль доступа',
  'Choose at least one priority.': 'Выберите хотя бы один приоритет.',
  'Choose no more than three priorities.': 'Выберите не больше трёх приоритетов.',

  // ---- security_constraints (v3) ----
  'How strict are your information-access constraints?': 'Насколько строгие у вас ограничения доступа к информации?',
  'This follow-up appears only when compliance is selected.': 'Этот уточняющий вопрос появляется, только если выбран комплаенс.',
  'Standard role-based access': 'Обычный доступ по ролям',
  'Strict separation and audit trails': 'Строгое разделение и журнал аудита',
  'Industry or legal requirements': 'Отраслевые или юридические требования',
  'Select the closest access-control requirement.': 'Выберите наиболее близкое требование к доступу.',

  // ---- timezone_span ----
  'How far apart are your working hours?': 'Насколько различаются ваши рабочие часы?',
  'Think about the earliest and latest regular working times.': 'Подумайте о самом раннем и самом позднем обычном рабочем времени.',
  'Mostly the same hours': 'В основном одни и те же часы',
  'About 3–6 hours apart': 'Разница примерно 3–6 часов',
  'More than 6 hours apart': 'Разница больше 6 часов',
  'Select the closest timezone range.': 'Выберите наиболее близкий разброс часовых поясов.',

  // ---- office_days ----
  'How many office days are expected each week?': 'Сколько дней в неделю ожидается работа в офисе?',
  'Enter the usual expectation, not occasional events.': 'Укажите обычное ожидание, а не разовые события.',
  days: 'дн.',
  'Enter the expected number of office days.': 'Укажите ожидаемое число офисных дней.',
  'Enter a value from 0 to 5.': 'Введите число от 0 до 5.',

  // ---- meeting_hours (v2, v3) ----
  'How many hours per person go to meetings each week?': 'Сколько часов в неделю у одного человека уходит на встречи?',
  'Use a typical week, not the busiest one.': 'Возьмите обычную неделю, а не самую загруженную.',
  'How much of a typical week disappears into meetings?': 'Сколько времени в обычную неделю «съедают» встречи?',
  'Estimate the average per person.': 'Оцените в среднем на одного человека.',
  hours: 'ч',
  'Enter weekly meeting hours.': 'Укажите часы встреч в неделю.',
  'Enter a value from 0 to 40.': 'Введите число от 0 до 40.',

  // ---- async_maturity ----
  'How are decisions documented today?': 'Как сейчас фиксируются решения?',
  'Choose what happens most often.': 'Выберите то, что происходит чаще всего.',
  'Mostly discussed in meetings': 'В основном обсуждаются на встречах',
  'Important decisions are documented': 'Важные решения записываются',
  'Written context is the default': 'Письменный контекст — норма',
  'Select the closest description.': 'Выберите наиболее близкое описание.',

  // ---- tool_count ----
  'How many tools does the team use every week?': 'Сколько инструментов команда использует каждую неделю?',
  'Count messaging, project, documentation and meeting tools.': 'Считайте мессенджеры, трекеры задач, документацию и сервисы для встреч.',
  tools: 'шт.',
  'Enter the number of tools.': 'Укажите число инструментов.',
  'Enter a value of at least 1.': 'Введите число не меньше 1.',
  'For this demo, enter a value up to 30.': 'В этой демоверсии — не больше 30.',

  // ---- result step ----
  'Building your recommendation…': 'Готовим вашу рекомендацию…',
  'We could not build the recommendation': 'Не удалось подготовить рекомендацию',
  'Try again': 'Попробовать ещё раз',

  // ---- results ----
  'Async-native': 'Асинхронная работа',
  'Your team will benefit from written context, fewer mandatory meetings and explicit response windows.':
    'Вашей команде помогут письменный контекст, меньше обязательных встреч и понятные сроки ответа.',
  'Move routine status updates to written check-ins.': 'Перевести регулярные статусы в письменные отчёты.',
  'Define response-time expectations by channel.': 'Договориться о сроках ответа в каждом канале.',
  'Record decisions in one searchable place.': 'Записывать решения в одно место с поиском.',
  'Structured hybrid': 'Структурированный гибрид',
  'Your team needs a clear reason for office days and equal access to decisions for remote participants.':
    'Команде нужна понятная цель офисных дней и равный доступ к решениям для удалённых участников.',
  'Give each office day a defined purpose.': 'Дать каждому офисному дню конкретную цель.',
  'Document decisions before the end of the day.': 'Фиксировать решения до конца дня.',
  'Avoid meetings where only part of the team can participate.': 'Избегать встреч, в которых может участвовать только часть команды.',
  'Office-led with focus protection': 'Офис с защитой времени на фокус',
  'Your team can keep an office-led model while protecting uninterrupted work and documenting key decisions.':
    'Команда может остаться в офисной модели, если защитит время для работы без отвлечений и будет фиксировать ключевые решения.',
  'Create meeting-free focus blocks.': 'Выделить блоки времени без встреч.',
  'Use the office for collaboration rather than status reporting.': 'Использовать офис для совместной работы, а не для отчётов о статусе.',
  'Publish decisions for people who were not in the room.': 'Публиковать решения для тех, кого не было на встрече.',
  'Balanced baseline': 'Сбалансированная основа',
  'Your answers do not point to one dominant model. Start with shared rules and measure what improves.':
    'Ваши ответы не указывают на одну модель. Начните с общих правил и измеряйте, что улучшается.',
  'Agree where decisions are recorded.': 'Договориться, где записываются решения.',
  'Define which work requires a meeting.': 'Определить, какая работа действительно требует встречи.',
  'Review the model after 30 days.': 'Пересмотреть модель через 30 дней.',
  'Meeting-heavy': 'Слишком много встреч',
  'Meeting load is likely limiting execution time, regardless of where the team works.':
    'Нагрузка встречами, скорее всего, отнимает время на работу — независимо от того, где работает команда.',
  'Replace routine status meetings with written updates.': 'Заменить регулярные статус-встречи письменными апдейтами.',
  'Require an owner and decision for every recurring meeting.': 'У каждой регулярной встречи должны быть ответственный и решение.',
  'Cancel one recurring meeting as a controlled experiment.': 'Отменить одну регулярную встречу в качестве эксперимента.',
  'Compliance-aware scale': 'Масштаб с учётом комплаенса',
  'The operating model must preserve access boundaries and auditability without turning every decision into a meeting.':
    'Модель работы должна сохранять границы доступа и аудит, не превращая каждое решение во встречу.',
  'Separate decision records from restricted source material.': 'Хранить записи о решениях отдельно от материалов с ограниченным доступом.',
  'Make access ownership explicit for every workspace.': 'Явно назначить ответственного за доступ в каждом рабочем пространстве.',
  'Audit exceptions instead of adding blanket approval steps.': 'Проверять исключения вместо того, чтобы добавлять согласования для всего.',
  'View the action list': 'Посмотреть план действий',

  // ---- variant B result framing ----
  'Your team is ready to reduce meetings': 'Ваша команда готова сократить встречи',
  'See the 30-day action list': 'План действий на 30 дней',
  'Your hybrid model needs clearer rules': 'Вашей гибридной модели нужны более чёткие правила',
  'Your office model can be more intentional': 'Офисную модель можно сделать более осознанной',
  'Your team needs a shared operating baseline': 'Вашей команде нужна общая основа работы',
  'Meetings are consuming your operating capacity': 'Встречи съедают рабочее время команды',
  'Reveal the first three changes': 'Показать первые три изменения',
  'Your team can move faster asynchronously': 'Асинхронно ваша команда может двигаться быстрее',
  'Your hybrid setup needs firmer rules': 'Вашему гибридному формату нужны более жёсткие правила',
  'Your office model needs focus protection': 'Офисной модели нужна защита времени на фокус',
  'Your team needs one shared operating baseline': 'Вашей команде нужна единая основа работы',
  'Your team needs a compliance-aware operating model': 'Вашей команде нужна модель работы с учётом комплаенса',
  'Open the implementation details': 'Открыть детали внедрения',
};

/**
 * Generic validation messages produced by the shared engine when the config has no text of its own
 * (they contain numbers, so they are matched by pattern).
 */
export const genericRu: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^This field is required\.$/, () => 'Это поле обязательно.'],
  [/^Enter a number\.$/, () => 'Введите число.'],
  [/^Enter a whole number\.$/, () => 'Введите целое число.'],
  [/^Enter a multiple of (.+)\.$/, (m) => `Введите число, кратное ${m[1]}.`],
  [/^Enter a value of at least (.+)\.$/, (m) => `Введите число не меньше ${m[1]}.`],
  [/^Enter a value up to (.+)\.$/, (m) => `Введите число не больше ${m[1]}.`],
  [/^Choose one option\.$/, () => 'Выберите один вариант.'],
  [/^Choose one of the listed options\.$/, () => 'Выберите один из предложенных вариантов.'],
  [/^Choose one or more options\.$/, () => 'Выберите один или несколько вариантов.'],
  [/^Choose from the listed options\.$/, () => 'Выбирайте из предложенных вариантов.'],
  [/^Choose at least one option\.$/, () => 'Выберите хотя бы один вариант.'],
  [/^Choose at least (\d+)\.$/, (m) => `Выберите не меньше ${m[1]}.`],
  [/^Choose no more than (\d+)\.$/, (m) => `Выберите не больше ${m[1]}.`],
];
