/* UI strings. Item and mood names live in assets/items.json instead, since
   they're generated alongside the art — one source per thing.

   "zh" is Traditional Chinese, Hong Kong usage: 今日 over 今天, 儲存 over 保存,
   封存 over 归档, 衛衣 for a hoodie, 冷帽 for a beanie. The key stays "zh" so
   stored preferences keep working. */

const STRINGS = {
  today:            { en: "Today",            zh: "今日" },
  // The calendar and the list are both "history"; naming one of them History
  // would make the other look like something else. Say what each one shows.
  history:          { en: "Calendar",         zh: "月曆" },
  entryList:        { en: "Entries",          zh: "記錄" },
  closet:           { en: "Closet",           zh: "衣櫥" },
  tags:             { en: "Tags",             zh: "標籤" },

  photos:           { en: "Photos",           zh: "相片" },
  addPhoto:         { en: "Add photo",        zh: "加相片" },
  photoLimit:       { en: "Up to 3",          zh: "最多 3 張" },
  removePhoto:      { en: "Remove photo",     zh: "移除相片" },
  noEntries:        { en: "No entries yet — today is a good place to start.",
                      zh: "仲未有記錄 — 不如由今日開始。" },
  closePhoto:       { en: "Close",            zh: "關閉" },
  close:            { en: "Close",            zh: "關閉" },
  enlarge:          { en: "View larger",      zh: "放大檢視" },

  pullToRefresh:    { en: "Pull to refresh",  zh: "下拉更新" },
  releaseToRefresh: { en: "Release to refresh", zh: "放開即更新" },
  refreshing:       { en: "Updating…",        zh: "更新中…" },

  noteLabel:        { en: "Anything you want to remember?", zh: "有什麼想記低嗎？" },
  notePlaceholder:  { en: "today I…",         zh: "今日我…" },
  tagsLabel:        { en: "What did you get up to?", zh: "今日做咗啲乜？" },
  saveToday:        { en: "Save today",       zh: "儲存今日" },
  saveEntry:        { en: "Save entry",       zh: "儲存記錄" },
  updateEntry:      { en: "Update entry",     zh: "更新記錄" },
  deleteEntry:      { en: "Delete this entry", zh: "刪除呢條記錄" },
  saved:            { en: "Saved ✓",          zh: "已儲存 ✓" },
  jumpToday:        { en: "Today",            zh: "返回今日" },

  confirmDelete:    { en: "Delete this entry? This can't be undone.", zh: "確定刪除呢條記錄？此操作無法復原。" },
  del:              { en: "Delete",           zh: "刪除" },
  keep:             { en: "Keep",             zh: "保留" },
  edit:             { en: "Edit",             zh: "編輯" },
  saveChanges:      { en: "Save changes",     zh: "儲存修改" },
  cancel:           { en: "Cancel",           zh: "取消" },
  noNote:           { en: "No note for this day.", zh: "呢日冇寫備註。" },

  moreTags:         { en: "More tags",        zh: "更多標籤" },
  fewerTags:        { en: "Show fewer",       zh: "收起" },
  manageTags:       { en: "Manage tags",      zh: "管理標籤" },
  all:              { en: "All",              zh: "全部" },

  entries:          { en: "entries",          zh: "條記錄" },
  dayStreak:        { en: "day streak",       zh: "連續日數" },
  avgMonth:         { en: "avg this month",   zh: "本月平均" },
  activities:       { en: "Activities",       zh: "活動分析" },
  mostLogged:       { en: "Most logged this month", zh: "本月最常記錄" },
  vs:               { en: "vs",               zh: "對比" },
  needMore:         { en: "Keep logging — mood comparisons appear once a tag has 5 entries.",
                      zh: "繼續記錄 — 某個標籤累積 5 條記錄後就會顯示心情對比。" },

  character:        { en: "Character",        zh: "角色" },
  head:             { en: "Head",             zh: "頭部" },
  faceAcc:          { en: "Face",             zh: "面部" },
  hair:             { en: "Hair",             zh: "髮色" },
  tops:             { en: "Tops",             zh: "上身" },
  bottoms:          { en: "Bottoms",          zh: "下身" },
  none:             { en: "None",             zh: "無" },
  coveredByDress:   { en: "covered by dress",  zh: "被洋裝遮蓋" },
  entriesLogged:    { en: "entries logged",   zh: "條記錄" },
  moreToUnlock:     { en: "more to unlock",   zh: "條後解鎖" },

  tagsHint:         { en: "Archive keeps past entries intact", zh: "封存唔會影響過往記錄" },
  newTag:           { en: "New tag",          zh: "新標籤" },
  add:              { en: "Add",              zh: "新增" },
  done:             { en: "Done",             zh: "完成" },
  archive:          { en: "Archive",          zh: "封存" },
  restore:          { en: "Restore",          zh: "復原" },
  deleteTagUsed:    { en: "It will be removed from",  zh: "佢會喺" },
  deleteTagUsed2:   { en: "past entries. Archiving keeps your history intact.",
                      zh: "條過往記錄中移除。封存就可以保留完整記錄。" },

  groupLife:        { en: "Life",             zh: "生活" },
  groupSocial:      { en: "Social",           zh: "社交" },
  groupHealth:      { en: "Health",           zh: "健康" },
  groupLeisure:     { en: "Leisure",          zh: "休閒" },
};

/* Built-in tags translate by id. A tag the user has renamed carries
   renamed:true and keeps whatever they typed, in whichever language. */
const TAG_STRINGS = {
  t_work: "返工", t_study: "讀書", t_chores: "家務", t_errands: "辦事", t_shopping: "購物",
  t_friends: "朋友", t_family: "家人", t_partner: "伴侶", t_party: "聚會", t_alone: "獨處",
  t_exercise: "運動", t_walk: "散步", t_sleep_good: "瞓得好", t_sleep_bad: "瞓得差",
  t_unwell: "唔舒服", t_reading: "閱讀", t_gaming: "打機", t_watching: "睇戲",
  t_music: "音樂", t_cooking: "煮飯", t_outdoors: "戶外",
};

const WEEKDAYS = {
  en: ["S", "M", "T", "W", "T", "F", "S"],
  zh: ["日", "一", "二", "三", "四", "五", "六"],
};

const LOCALE = { en: undefined, zh: "zh-HK" };
