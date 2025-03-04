const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const config = require('./src/config/config.js').development;

const app = express();
app.use(express.json());
app.use(cors());

const db = mysql.createConnection({
  host: config.host,
  user: config.user,
  password: config.password,
  database: config.database,
});

db.connect((err) => {
  if (err) {
    console.error("Database connection failed: " + err.stack);
    return;
  }
  console.log("Connected to MySQL database.");
});

const generateToken = (user) => {
  return jwt.sign({ id: user.id, email: user.email, role: user.role_ }, "your_secret_key", { expiresIn: "1h" });
};

const verifyToken = (req, res, next) => {
  const token = req.headers["authorization"];
  if (!token) {
    return res.status(403).json({ success: false, message: "No token provided." });
  }

  jwt.verify(token, "your_secret_key", (err, decoded) => {
    if (err) {
      return res.status(401).json({ success: false, message: "Failed to authenticate token." });
    }
    req.user = decoded;
    next();
  });
};

app.post("/login", (req, res) => {
  const { email, password_ } = req.body;

  if (!email || !password_) {
    return res.status(400).json({ success: false, message: "❌ Please provide email and password." });
  }

  db.query("SELECT * FROM users WHERE email = ?", [email], async (err, results) => {
    if (err) {
      console.error("❌ Database error:", err);
      return res.status(500).json({ success: false, message: "⚠️ Server error. Please try again later." });
    }

    if (results.length === 0) {
      return res.status(401).json({ success: false, message: "⚠️ Invalid credentials." });
    }

    const user = results[0];

    const isPasswordValid = await bcrypt.compare(password_, user.password_);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: "⚠️ Invalid credentials." });
    }

    db.query("SELECT * FROM questions WHERE staff_email = ?", [email], (err, surveyResults) => {
      if (err) {
        console.error("❌ Database error:", err);
        return res.status(500).json({ success: false, message: "⚠️ Server error. Please try again later." });
      }

      const hasCreatedSurvey = surveyResults.length > 0;

      const token = generateToken(user);

      res.status(200).json({
        success: true,
        message: "✅ Login successful!",
        token,
        hasCreatedSurvey,
      });
    });
  });
});

app.post("/register", (req, res) => {
  const { email, userID, role_, password_ } = req.body;

  if (!email || !userID || !role_ || !password_) {
    return res.status(400).json({ success: false, message: "❌ Please fill all fields." });
  }

  db.query("SELECT * FROM users WHERE email = ?", [email], async (err, results) => {
    if (err) {
      console.error("❌ Database error:", err);
      return res.status(500).json({ success: false, message: "⚠️ Server error. Please try again later." });
    }

    if (results.length > 0) {
      return res.status(400).json({ success: false, message: "⚠️ Email already registered." });
    }

    const hashedPassword = await bcrypt.hash(password_, 10);

    db.query(
      "INSERT INTO users (email, userID, role_, password_) VALUES (?, ?, ?, ?)",
      [email, userID, role_, hashedPassword],
      (err, results) => {
        if (err) {
          console.error("❌ Database error:", err);
          return res.status(500).json({ success: false, message: "⚠️ Server error. Please try again later." });
        }

        res.status(201).json({ success: true, message: "✅ Registration successful!" });
      }
    );
  });
});

app.post("/save-survey", verifyToken, async (req, res) => {
  console.log("Request Body:", req.body);
  const surveyData = req.body;
  const staff_email = req.user.email;
  const survey_id = req.body.survey_id;
  const surveyTitle = req.body.surveyTitle;

  if (!surveyData || !Array.isArray(surveyData.questions)) {
    console.error("Invalid data format:", surveyData);
    return res.status(400).json({ error: "Invalid data format" });
  }

  try {
    const queryPromises = surveyData.questions.map((q) => {
      return new Promise((resolve, reject) => {
        db.query(
          "INSERT INTO questions (question_text, shuffle_answers, shuffle_questions, skip_based_on_answer, multiple_choice, scale, score_question, add_other_option, require_answer, texts, survey_id, staff_email, survey_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            q.text,
            q.shuffle_answers || false,
            q.shuffle_questions || false,
            q.skip_based_on_answer || false,
            q.type === "multiple" ? true : false,
            q.type === "scale" ? true : false,
            q.score_question || false,
            q.add_other_option || false,
            q.require_answer || false,
            q.type === "text" ? true : false,
            survey_id,
            staff_email,
            surveyTitle,
          ],
          (err, result) => {
            if (err) {
              console.error("Error inserting question:", err);
              return reject(err);
            }
            const questionId = result.insertId;

            if (q.options && Array.isArray(q.options)) {
              const optionQueries = q.options.map((opt) => {
                return new Promise((resOpt, rejOpt) => {
                  db.query(
                    "INSERT INTO options (question_id, option_text) VALUES (?, ?)",
                    [questionId, opt],
                    (err) => {
                      if (err) {
                        console.error("Error inserting option:", err);
                        return rejOpt(err);
                      }
                      resOpt();
                    }
                  );
                });
              });

              Promise.all(optionQueries)
                .then(() => resolve())
                .catch((err) => reject(err));
            } else {
              resolve();
            }
          }
        );
      });
    });

    await Promise.all(queryPromises);
    res.status(200).json({ message: "Survey saved successfully!", survey_id });
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Internal server error", details: error.message });
  }
});

app.post('/save-permissions', verifyToken, (req, res) => {
  const {
    startDate,
    startTime,
    endDate,
    endTime,
    schedulingFrequency,
    daysOfWeek,
    randomTiming,
    timeDifference,
    sendReminders,
    assignedRoles,
    responseLimit,
    survey_id,
    surveyTitle, // Added surveyTitle
  } = req.body;

  if (!survey_id) {
    return res.status(400).json({ success: false, message: "❌ Survey ID is required." });
  }

  const query = `
    INSERT INTO permissions (
      id,
      start_date, 
      start_time, 
      end_date, 
      end_time, 
      scheduling_frequency, 
      days_of_week, 
      random_timing, 
      time_difference, 
      send_reminders, 
      assigned_roles, 
      response_limit,
      survey_title
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.query(
    query,
    [
      survey_id,
      startDate,
      startTime,
      endDate,
      endTime,
      JSON.stringify(schedulingFrequency),
      JSON.stringify(daysOfWeek),
      randomTiming,
      timeDifference,
      sendReminders,
      assignedRoles,
      responseLimit,
      surveyTitle, // Added surveyTitle
    ],
    (err, result) => {
      if (err) {
        console.error('Error saving permissions:', err);
        res.status(500).send('Error saving permissions');
        return;
      }
      res.status(200).send('Permissions saved successfully');
    }
  );
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
