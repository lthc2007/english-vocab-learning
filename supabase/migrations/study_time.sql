-- 学习时长记录表
CREATE TABLE IF NOT EXISTS study_time (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  seconds INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, date)
);

ALTER TABLE study_time ENABLE ROW LEVEL SECURITY;

-- 用户只能管理自己的学习时长
CREATE POLICY "Users can manage own study time"
  ON study_time FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);