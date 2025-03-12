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
  const { email, password_, role } = req.body;
  console.log("Request body:", req.body);

  if (!email || !password_ || !role) {
    return res.status(400).json({ success: false, message: "❌ Please provide email, password, and role." });
  }

  db.query("SELECT * FROM users WHERE email = ? AND role_ = ?", [email, role], async (err, results) => {
    if (err) {
      console.error("❌ Database error:", err);
      return res.status(500).json({ success: false, message: "⚠️ Server error. Please try again later." });
    }

    console.log("Database query results:", results);

    if (results.length === 0) {
      return res.status(401).json({ success: false, message: "⚠️ Invalid credentials or role mismatch." });
    }

    const user = results[0];

    const isPasswordValid = await bcrypt.compare(password_, user.password_);
    console.log("Password comparison result:", isPasswordValid);

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
      console.log("Generated token:", token);

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
  const staff_email=req.user.email

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
      survey_title,
      staff_email
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?)
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
      surveyTitle,
      staff_email // Added surveyTitle
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
const { v4: uuidv4 } = require('uuid');

app.post('/feedback', (req, res) => {
  const feedbacks = req.body; // Array of feedback objects from frontend
  const fbid = uuidv4(); // Generate a unique feedback batch ID

  const query = `
    INSERT INTO feedbacks (
      student, facultyCourse, periodical, clarity, topicDiscussions,
      timeManagement, syllabusCoverage, satisfaction, comments, fbid
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `;

  let successCount = 0;
  let errorCount = 0;

  // Loop through each feedback and insert it individually
  feedbacks.forEach((feedback, index) => {
    const values = [
      feedback.student,
      feedback.facultyCourse,
      feedback.periodical,
      feedback.clarity,
      feedback.topicDiscussions,
      feedback.timeManagement,
      feedback.syllabusCoverage,
      feedback.satisfaction,
      feedback.comments,
      fbid, // Include the feedback batch ID
    ];

    db.query(query, values, (err, results) => {
      if (err) {
        console.error(`Error inserting feedback at index ${index}:`, err);
        errorCount++;
      } else {
        successCount++;
      }

      // Check if all feedbacks have been processed
      if (index === feedbacks.length - 1) {
        if (errorCount > 0) {
          res.status(500).json({
            message: `Failed to submit ${errorCount} feedback(s).`,
            successCount: successCount,
            errorCount: errorCount,
            fbid: fbid, // Return the feedback batch ID
          });
        } else {
          res.status(201).json({
            message: 'All feedbacks submitted successfully!',
            successCount: successCount,
            fbid: fbid, // Return the feedback batch ID
          });
        }
      }
    });
  });
});
app.post('/submit-feedback', (req, res) => {
  const { name, rollno, facultyname, videosUseful, materialsUseful, clearPSLevels, feedback } = req.body;

  const sql = `INSERT INTO skillfb (Name, RollNo, Faculty, Isvideo_Useful, Materialsuseful, clearPslevels, Feedback) 
               VALUES (?, ?, ?, ?, ?, ?, ?)`;
  const values = [name, rollno, facultyname, videosUseful, materialsUseful, clearPSLevels, feedback];

  db.query(sql, values, (err, result) => {
    if (err) {
      console.error('Error inserting data:', err);
      res.status(500).send('Error submitting feedback');
      return;
    }
    res.status(200).send('Feedback submitted successfully');
  });
});

// Add this endpoint in your backend code
app.get("/get-surveys", verifyToken, (req, res) => {
  const staff_email = req.user.email; // Get the logged-in faculty's email from the token

  const query = `
    SELECT DISTINCT start_date, survey_title, staff_email,end_date
    FROM permissions 
    WHERE 
      staff_email = ? 
      AND start_date <= CURDATE() 
      AND end_date >= CURDATE() 
  `;

  db.query(query, [staff_email], (err, results) => {
    if (err) {
      console.error("Error fetching surveys:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }
    res.json(results); // Return the list of surveys
  });
});

app.get("/get-completed-surveys", verifyToken, (req, res) => {
  const staff_email = req.user.email;

  const query = `
    SELECT DISTINCT start_date, survey_title, staff_email, end_date
    FROM permissions 
    WHERE staff_email = ? AND end_date < CURDATE()
  `;

  db.query(query, [staff_email], (err, results) => {
    if (err) {
      console.error("Error fetching completed surveys:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }
    res.json(results);
  });
});
app.get("/get-scheduled-surveys", verifyToken, (req, res) => {
  const staff_email = req.user.email;

  const query = `
    SELECT DISTINCT start_date, survey_title, staff_email, end_date
    FROM permissions 
    WHERE staff_email = ? AND start_date > CURDATE()
  `;

  db.query(query, [staff_email], (err, results) => {
    if (err) {
      console.error("Error fetching completed surveys:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }
    res.json(results);
  });
});


// Get a student by Rollno
app.get("/student/:email", (req, res) => {
  const { email } = req.params;
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const sql = "SELECT * FROM studentdetails WHERE Email = ?";
  db.query(sql, [email], (err, result) => {
    if (err) {
      console.error("Error fetching student:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json(result.length > 0 ? result[0] : null);
  });
});

// Add a new student
app.post("/student", (req, res) => {
  const student = req.body;
  if (!student.Email || !student.Rollno) {
    return res.status(400).send({ message: "Email and Rollno are required" });
  }

  const sql = "INSERT INTO studentdetails SET ?";
  db.query(sql, student, (err, result) => {
    if (err) {
      console.error("Error saving student details:", err);
      return res.status(500).send({ message: "Error saving student details", error: err });
    }
    res.send({ message: "Student added successfully", id: result.insertId });
  });
});

// Update student details
app.put("/student/:rollno", (req, res) => {
  const { rollno } = req.params;
  const student = req.body;
  if (!rollno) {
    return res.status(400).send({ message: "Rollno is required" });
  }

  const sql = "UPDATE studentdetails SET ? WHERE Rollno = ?";
  db.query(sql, [student, rollno], (err, result) => {
    if (err) {
      console.error("Error updating student details:", err);
      return res.status(500).send({ message: "Error updating student details", error: err });
    }
    if (result.affectedRows === 0) {
      return res.status(404).send({ message: "Student not found" });
    }
    res.send({ message: "Student updated successfully" });
  });
});


app.post('/students', (req, res) => {
  const { selectedLevels, selectedRole, startRange, endRange } = req.body;

  console.log("Received request body:", req.body); // Log the request body

  let query = 'SELECT Name,Year,Email,Department FROM studentdetails WHERE 1=1';
  let queryParams = [];

  // Add condition for selectedRole
  if (selectedRole) {
    query += ' AND Mentor = ?';
    queryParams.push(selectedRole);
  }

  // Add condition for RP range
  if (startRange && endRange) {
    query += ' AND Rp BETWEEN ? AND ?';
    queryParams.push(startRange, endRange);
  }

  // Add conditions for selectedLevels
  if (selectedLevels && selectedLevels.length > 0) {
    selectedLevels.forEach(level => {
      const lastSpaceIndex = level.lastIndexOf(' ');
      const skill = level.substring(0, lastSpaceIndex).trim();
      const levelNumber = level.substring(lastSpaceIndex + 1).trim();

      let column;
      switch (skill.toUpperCase()) {
        case 'C PROGRAMMING':
          column = 'C_levels';
          break;
        case 'PYTHON':
          column = 'Python_Levels';
          break;
        case 'JAVA':
          column = 'Java_levels';
          break;
        case 'SQL':
          column = 'DBMS_levels';
          break;
        case 'PROBLEM SOLVING':
          column = 'ProblemSolving';
          break;
        case 'UIUX':
          column = 'UIUX';
          break;
        case 'APTITUDE':
          column = 'Aptitude';
          break;
        default:
          console.error(`Unknown skill: ${skill}`);
          return;
      }

      // Add condition for each skill-level pair
      query += ` AND ${column} = ?`;
      queryParams.push(levelNumber.replace('Level', ''));
    });
  }

  console.log("Generated SQL Query:", query); // Log the final SQL query
  console.log("Query Parameters:", queryParams); // Log the query parameters

  // Execute the query
  db.query(query, queryParams, (error, results) => {
    if (error) {
      console.error('Database error:', error); // Log the database error
      return res.status(500).json({ error: 'Database error', details: error.message });
    }
    console.log("Query Results:", results); // Log the query results
    res.json(results);
  });
});
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
