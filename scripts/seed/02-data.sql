-- Benchmark seed data (~10k orders, manageable for local dev)

TRUNCATE daily_metrics, order_items, orders, products, users, regions RESTART IDENTITY CASCADE;

INSERT INTO regions (name, country) VALUES
  ('华东', '中国'),
  ('华北', '中国'),
  ('华南', '中国'),
  ('西南', '中国'),
  ('西北', '中国');

INSERT INTO products (name, category, price, created_at) VALUES
  ('智能手机 Pro', '电子产品', 4999.00, '2024-01-01'),
  ('无线耳机', '电子产品', 899.00, '2024-01-01'),
  ('笔记本电脑', '电子产品', 6999.00, '2024-01-15'),
  ('运动T恤', '服装', 199.00, '2024-02-01'),
  ('牛仔裤', '服装', 399.00, '2024-02-01'),
  ('休闲鞋', '服装', 599.00, '2024-02-15'),
  ('咖啡豆 500g', '食品', 89.00, '2024-03-01'),
  ('有机牛奶', '食品', 35.00, '2024-03-01'),
  ('坚果礼盒', '食品', 128.00, '2024-03-15'),
  ('护肤套装', '美妆', 459.00, '2024-04-01'),
  ('口红', '美妆', 299.00, '2024-04-01'),
  ('洗发水', '美妆', 79.00, '2024-04-15'),
  ('台灯', '家居', 159.00, '2024-05-01'),
  ('收纳箱', '家居', 69.00, '2024-05-01'),
  ('床上四件套', '家居', 399.00, '2024-05-15'),
  ('儿童绘本', '图书', 45.00, '2024-06-01'),
  ('编程入门', '图书', 89.00, '2024-06-01'),
  ('历史通史', '图书', 128.00, '2024-06-15'),
  ('跑步机', '运动', 2999.00, '2024-07-01'),
  ('瑜伽垫', '运动', 129.00, '2024-07-01');

-- 2000 users across regions and channels (mix of historical and recent)
INSERT INTO users (email, name, region_id, channel, created_at)
SELECT
  'user' || g || '@benchmark.local',
  '用户' || g,
  (g % 5) + 1,
  CASE (g % 4)
    WHEN 0 THEN 'organic'
    WHEN 1 THEN 'paid'
    WHEN 2 THEN 'referral'
    ELSE 'social'
  END,
  CASE
    WHEN g % 5 = 0 THEN TIMESTAMP '2024-01-01' + (g % 365) * INTERVAL '1 day'
    ELSE CURRENT_DATE - ((g % 60) * INTERVAL '1 day')
  END
FROM generate_series(1, 2000) AS g;

-- ~10000 orders: mix historical (2024) and recent (last 90 days)
INSERT INTO orders (user_id, status, total_amount, created_at)
SELECT
  (g % 2000) + 1,
  CASE
    WHEN g % 50 = 0 THEN 'cancelled'
    WHEN g % 30 = 0 THEN 'pending'
    ELSE 'completed'
  END,
  ROUND((50 + (g % 500) + random() * 200)::numeric, 2),
  CASE
    WHEN g % 3 = 0 THEN TIMESTAMP '2024-06-01' + (g % 450) * INTERVAL '1 day'
    ELSE CURRENT_DATE - ((g % 90) * INTERVAL '1 day') - ((g % 24) * INTERVAL '1 hour')
  END
FROM generate_series(1, 10000) AS g;

-- order items: 1-3 items per order
INSERT INTO order_items (order_id, product_id, quantity, unit_price, amount)
SELECT
  o.id,
  ((o.id + i) % 20) + 1,
  (i % 3) + 1,
  p.price,
  p.price * ((i % 3) + 1)
FROM orders o
CROSS JOIN generate_series(0, 2) AS i
JOIN products p ON p.id = ((o.id + i) % 20) + 1
WHERE (o.id + i) % 3 != 0 OR i = 0;

-- Fix order total_amount to match items sum
UPDATE orders o
SET total_amount = sub.item_total
FROM (
  SELECT order_id, SUM(amount) AS item_total
  FROM order_items
  GROUP BY order_id
) sub
WHERE o.id = sub.order_id;

-- Daily metrics for last 90 days
INSERT INTO daily_metrics (metric_date, gmv, order_count, new_users)
SELECT
  d::date,
  COALESCE(SUM(o.total_amount) FILTER (WHERE o.status = 'completed'), 0),
  COUNT(o.id) FILTER (WHERE o.status = 'completed'),
  COUNT(u.id)
FROM generate_series(CURRENT_DATE - 89, CURRENT_DATE, '1 day') AS d
LEFT JOIN orders o ON o.created_at::date = d::date
LEFT JOIN users u ON u.created_at::date = d::date
GROUP BY d::date
ORDER BY d::date;
