const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");

const app = express();
app.use(express.json()); // To parse JSON requests
app.use(cors()); // Allow cross-origin requests

// MySQL Connection
const db = mysql.createConnection({
  host: "localhost", // Change if hosted remotely
  user: "root", // Your MySQL username
  password: "dhurshi1234", // Your MySQL password
  database: "survey_db", // Your database name
});

db.connect((err) => {
  if (err) {
    console.error("Database connection failed: " + err.stack);
    return;
  }
  console.log("Connected to MySQL database.");
});

// Route to save survey questions and options
app.post("/save-survey", (req, res) => {
  const surveyData = req.body; // Get survey data from the frontend

  if (!surveyData || !Array.isArray(surveyData)) {
    return res.status(400).json({ error: "Invalid data format" });
  }

  // Insert questions and options into the database
  const queryPromises = surveyData.map((q) => {
    return new Promise((resolve, reject) => {
      // Insert question
      db.query(
        "INSERT INTO questions (question_text, shuffle_answers, shuffle_questions, skip_based_on_answer, multiple_choice, scale, score_question, add_other_option, require_answer,texts) VALUES (?, ?, ?, ?, ?, ?, ?, ?,?, ?)",
        [
          q.text, //completed
          q.shuffle_answers || false,//completed
          q.shuffle_questions || false,//completed
          q.skip_based_on_answer || false, //completed
          q.type === "multiple" ? true : false, // completed
          q.type === "scale" ? true : false, // completed
          q.score_question || false, //completed
          q.add_other_option || false, // completed
          q.require_answer || false,//completed
          q.type === "text" ? true : false,
        ],
        (err, result) => {
          if (err) return reject(err);
          const questionId = result.insertId;

          // Insert options
          if (q.options && Array.isArray(q.options)) {
            const optionQueries = q.options.map((opt) => {
              return new Promise((resOpt, rejOpt) => {
                db.query(
                  "INSERT INTO options (question_id, option_text) VALUES (?, ?)",
                  [questionId, opt],
                  (err) => {
                    if (err) return rejOpt(err);
                    resOpt();
                  }
                );
              });
            });

            // Wait for all options to be inserted
            Promise.all(optionQueries)
              .then(() => resolve())
              .catch((err) => reject(err));
          } else {
            resolve(); // No options to insert
          }
        }
      );
    });
  });

  // Execute all queries
  Promise.all(queryPromises)
    .then(() => res.status(200).json({ message: "Survey saved successfully!" }))
    .catch((err) => res.status(500).json({ error: "Database error", details: err }));
});

// Start server
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 