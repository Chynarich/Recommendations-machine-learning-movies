const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const { spawn } = require('child_process');

const app = express();
const port = 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Настройки для PostgreSQL
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'practice',
  password: 'postgres',
  port: 5432,
});

// Получение всех фильмов с жанрами
app.get('/api/movies', async (req, res) => {
  try {
    const result = await pool.query(`
          SELECT m.id, m.title, m.year, m.rating, array_agg(g.name) AS genres
          FROM movies m
          LEFT JOIN movie_genres mg ON m.id = mg.movie_id
          LEFT JOIN genres g ON mg.genre_id = g.id
          GROUP BY m.id
      `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка на сервере');
  }
});

// Получение всех жанров
app.get('/api/genres', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM genres');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка на сервере');
  }
});

// Добавление фильма в избранное
app.post('/api/select', async (req, res) => {
  const { movieId } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO selected_movies (movie_id) VALUES ($1) RETURNING *',
      [movieId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка на сервере');
  }
});

// Получение всех избранных фильмов
app.get('/api/selected', async (req, res) => {
  try {
    const result = await pool.query(`
          SELECT m.id, m.title, m.year, m.rating, array_agg(g.name) AS genres
          FROM movies m
          INNER JOIN selected_movies s ON m.id = s.movie_id
          LEFT JOIN movie_genres mg ON m.id = mg.movie_id
          LEFT JOIN genres g ON mg.genre_id = g.id
          GROUP BY m.id
      `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка на сервере');
  }
});

// Удаление фильма из избранного
app.delete('/api/unselect/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'DELETE FROM selected_movies WHERE movie_id = $1',
      [id]
    );
    res.status(200).send(`Фильм с id=${id} удален из избранного`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка на сервере');
  }
});

// Получение случайного фильма для рекомендаций
app.get('/api/recommend', async (req, res) => {
  try {
    const result = await pool.query(`
          SELECT m.id, m.title, m.year, m.rating, array_agg(g.name) AS genres
          FROM movies m
          LEFT JOIN movie_genres mg ON m.id = mg.movie_id
          LEFT JOIN genres g ON mg.genre_id = g.id
          WHERE m.id NOT IN (SELECT movie_id FROM user_interactions)
          GROUP BY m.id
          ORDER BY RANDOM()
          LIMIT 1
      `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка на сервере');
  }
});

// Обработка лайка или скипа фильма
app.post('/api/interact', async (req, res) => {
  const { movieId, liked } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO user_interactions (movie_id, liked) VALUES ($1, $2) RETURNING *',
      [movieId, liked]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка на сервере');
  }
});

app.delete('/api/reset', async (req, res) => {
  try {
    await pool.query('DELETE FROM user_interactions');
    res.sendStatus(204);
  } catch (err) {
    console.error('Ошибка при обнулении данных:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Тренировка модели и получение рекомендаций
app.get('/api/train_and_recommend', async (req, res) => {
  try {
    // 1. Получение данных для обучения
    const userInteractions = await pool.query(`
      SELECT m.id, m.title, m.year, m.rating, array_agg(g.name) AS genres, ui.liked
      FROM user_interactions ui
      INNER JOIN movies m ON ui.movie_id = m.id
      LEFT JOIN movie_genres mg ON m.id = mg.movie_id
      LEFT JOIN genres g ON mg.genre_id = g.id
      GROUP BY m.id, ui.liked
    `);

    // 2. Получение всех фильмов для рекомендаций
    const allMovies = await pool.query(`
      SELECT m.id, m.title, m.year, m.rating, array_agg(g.name) AS genres
      FROM movies m
      LEFT JOIN movie_genres mg ON m.id = mg.movie_id
      LEFT JOIN genres g ON mg.genre_id = g.id
      GROUP BY m.id
    `);

    // Проверка количества взаимодействий пользователя
    if (userInteractions.rowCount < 5) {
      // Если меньше 5 взаимодействий, возвращаем 5 случайных фильмов
      const randomMovies = allMovies.rows
        .sort(() => Math.random() - 0.5) // Перемешиваем массив фильмов
        .slice(0, 5); // Берем первые 5 фильмов
      console.log('5 рандомных');
      return res.json(randomMovies);
    }

    // Запуск модели машинного обучения с использованием Python
    const recommendations = await runModel(
      userInteractions.rows,
      allMovies.rows
    );

    console.log(recommendations.slice(0, 10));
    // Возврат 10 рекомендованных фильмов
    res.json(recommendations.slice(0, 10));
  } catch (err) {
    console.error('Ошибка во время тренировки модели:', err);
    res.status(500).send('Ошибка на сервере при тренировке модели');
  }
});

function runModel(userData, allMovies) {
  return new Promise((resolve, reject) => {
    const pythonProcess = spawn('python3', [
      'run_model.py',
      JSON.stringify(userData),
      JSON.stringify(allMovies),
    ]);

    let data = '';
    pythonProcess.stdout.on('data', (chunk) => {
      data += chunk;
    });

    pythonProcess.stderr.on('data', (chunk) => {
      console.error(`Ошибка в скрипте Python: ${chunk}`);
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python process exited with code ${code}`));
      }
      resolve(JSON.parse(data));
    });
  });
}

app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
});