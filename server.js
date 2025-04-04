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
app.get("/get-faculty-groups", verifyToken, (req, res) => {
  const staff_email = req.user.email;

  const query = `
    SELECT GroupID, GroupName 
    FROM student_groups_info 
    WHERE staffmail = ?
  `;

  db.query(query, [staff_email], (err, results) => {
    if (err) {
      console.error("Error fetching faculty groups:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }

    res.json(results);
  });
});

app.get("/get-draft-survey/:survey_id", verifyToken, (req, res) => {
  const { survey_id } = req.params;
  const staff_email = req.user.email;

  const query = `
    SELECT 
      q.id AS question_id,
      q.question_text,
      q.shuffle_answers,
      q.shuffle_questions,
      q.skip_based_on_answer,
      q.multiple_choice,
      q.scale,
      q.score_question,
      q.add_other_option,
      q.require_answer,
      q.texts,
      q.survey_name,
      o.id AS option_id,
      o.option_text
    FROM questions q
    LEFT JOIN options o ON q.id = o.question_id
    WHERE q.survey_id = ? AND q.staff_email = ? AND q.draft = 'draft'
  `;

  db.query(query, [survey_id, staff_email], (err, results) => {
    if (err) {
      console.error("Error fetching draft survey:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }

    const questions = results.reduce((acc, row) => {
      const question = acc.find((q) => q.id === row.question_id);
      if (!question) {
        acc.push({
          id: row.question_id,
          text: row.question_text,
          type: row.multiple_choice ? "multiple" : row.texts ? "text" : "scale",
          options: row.option_text ? [row.option_text] : [],
          shuffle_answers: row.shuffle_answers,
          shuffle_questions: row.shuffle_questions,
          skip_based_on_answer: row.skip_based_on_answer,
          score_question: row.score_question,
          add_other_option: row.add_other_option,
          require_answer: row.require_answer,
        });
      } else if (row.option_text) {
        question.options.push(row.option_text);
      }
      return acc;
    }, []);

    res.json({ survey_id, survey_name: results[0]?.survey_name, questions });
  });
});

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
        staffEmail: user.email, 
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
  const isDraft = req.body.draft === "draft"; // Check if it's a draft

  if (!surveyData || !Array.isArray(surveyData.questions)) {
    console.error("Invalid data format:", surveyData);
    return res.status(400).json({ error: "Invalid data format" });
  }

  try {
    const existingSurveyQuery = `
      SELECT COUNT(*) AS count FROM questions WHERE survey_id = ? AND staff_email = ?
    `;

    db.query(existingSurveyQuery, [survey_id, staff_email], async (err, results) => {
      if (err) {
        console.error("Error checking existing survey:", err);
        return res.status(500).json({ error: "Database error" });
      }

      const isExistingSurvey = results[0].count > 0;

      const queryPromises = surveyData.questions.map((q) => {
        return new Promise((resolve, reject) => {
          const sqlQuery = isExistingSurvey
            ? `UPDATE questions 
               SET question_text = ?, shuffle_answers = ?, shuffle_questions = ?, 
                   skip_based_on_answer = ?, multiple_choice = ?, scale = ?, 
                   score_question = ?, add_other_option = ?, require_answer = ?, 
                   texts = ?, survey_name = ?, draft = ?
               WHERE survey_id = ? AND staff_email = ?`
            : `INSERT INTO questions 
               (question_text, shuffle_answers, shuffle_questions, skip_based_on_answer, 
               multiple_choice, scale, score_question, add_other_option, require_answer, 
               texts, survey_id, staff_email, survey_name, draft) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

          const sqlParams = isExistingSurvey
            ? [
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
                surveyTitle,
                isDraft ? "draft" : null, // Fix: Null when finishing survey
                survey_id,
                staff_email,
              ]
            : [
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
                isDraft ? "draft" : null, // Fix: Null when finishing survey
              ];

          db.query(sqlQuery, sqlParams, (err, result) => {
            if (err) {
              console.error("Error saving survey:", err);
              return reject(err);
            }
            resolve();
          });
        });
      });

      await Promise.all(queryPromises);
      res.status(200).json({ message: isDraft ? "Survey saved as draft!" : "Survey saved successfully!", survey_id });
    });
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

app.get("/get-surveys", verifyToken, (req, res) => {
  const staff_email = req.user.email; // Get the logged-in faculty's email from the token

  const query = `
    SELECT DISTINCT start_date, survey_title, staff_email, end_date, start_time, end_time
    FROM permissions 
    WHERE 
      staff_email = ? 
      AND (
        (start_date < CURDATE()) -- Survey started in the past
        OR (start_date = CURDATE() AND start_time <= CURRENT_TIME()) -- Survey starts today and has already started
      )
      AND (
        (end_date > CURDATE()) -- Survey is ongoing in the future
        OR (end_date = CURDATE() AND end_time >= CURRENT_TIME()) -- Survey ends today but is still active
      )
  `;

  db.query(query, [staff_email], (err, results) => {
    if (err) {
      console.error("Error fetching surveys:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }
    
    console.log("Live Surveys:");
    results.forEach(survey => {
      console.log(`Survey Title: ${survey.survey_title}`);
    });

    res.json(results); // Return the list of surveys
  });
});

app.get("/get-drafts", verifyToken, (req, res) => {
  const staff_email = req.user.email;
  
  const query = `
    SELECT 
      survey_id, 
      survey_name, 
      staff_email
    FROM questions
    WHERE staff_email = ? AND draft = 'draft'
    GROUP BY survey_id, survey_name, staff_email
  `;
  
  db.query(query, [staff_email], (err, results) => {
    if (err) {
      console.error("Error fetching drafts:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }
    
    console.log("Fetching drafts for email:", staff_email);

    console.log("Drafts grouped by survey_id, survey_name, and staff_email:", results);
    
    res.json(results);
  });
});

app.get("/get-completed-surveys", verifyToken, (req, res) => {
  const staff_email = req.user.email;

  const query = `
    SELECT DISTINCT start_date, survey_title, staff_email, end_date, start_time, end_time
    FROM permissions 
    WHERE 
      staff_email = ? 
      AND (
        end_date < CURDATE() -- Completed if end_date is before today
        OR (start_date = CURDATE() AND end_date = CURDATE() AND end_time < CURRENT_TIME()) -- Completed if today is the start and end date, but time has passed
      )
  `;

  db.query(query, [staff_email], (err, results) => {
    if (err) {
      console.error("Error fetching completed surveys:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }

    console.log("Completed Surveys:");
    results.forEach(survey => {
      console.log(`Survey Title: ${survey.survey_title}`);
    });

    res.json(results);
  });
});

app.get("/get-scheduled-surveys", verifyToken, (req, res) => {
  const staff_email = req.user.email;

  const query = `
    SELECT DISTINCT start_date, survey_title, staff_email, end_date, start_time, end_time
    FROM permissions 
    WHERE 
      staff_email = ? 
      AND (
        start_date > CURDATE()  -- Future date (scheduled)
        OR (start_date = CURDATE() AND start_time > CURRENT_TIME()) -- Today, but time is in the future
      )
  `;

  db.query(query, [staff_email], (err, results) => {
    if (err) {
      console.error("Error fetching scheduled surveys:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }

    console.log("Scheduled Surveys:");
    results.forEach(survey => {
      console.log(`Survey Title: ${survey.survey_title}`);
    });

    res.json(results);
  });
});



// app.get("/get-surveysuser", verifyToken, (req, res) => {
//   const studentEmail = req.user.email; // Assuming the student's email is stored in the token

//   // Fetch the student's details (Year, Department, GroupID) from the student_groups table
//   const studentQuery = `
//     SELECT Year, Department, GroupID 
//     FROM student_groups 
//     WHERE Email = ?
//   `;

//   db.query(studentQuery, [studentEmail], (err, studentResults) => {
//     if (err) {
//       console.error("Error fetching student details:", err);
//       return res.status(500).json({ error: "Database error", details: err.message });
//     }

//     if (studentResults.length === 0) {
//       return res.status(404).json({ error: "Student not found" });
//     }

//     const { Year, Department, GroupID } = studentResults[0];

//     // Fetch surveys based on the student's Year, Department, or GroupID
//     const surveyQuery = `
//       SELECT DISTINCT start_date, survey_title, staff_email, end_date, start_time, end_time
//       FROM permissions 
//       WHERE 
//         (assigned_roles = ? AND ? IN (SELECT Email FROM student_groups WHERE Year = ?))
//         OR (assigned_roles = ? AND ? IN (SELECT Email FROM student_groups WHERE Department = ?))
//         OR (assigned_roles = ? AND ? IN (SELECT Email FROM student_groups WHERE GroupID = ?))
//     `;

//     const surveyParams = [
//       `Year:${Year}`, studentEmail, Year,
//       `Department:${Department}`, studentEmail, Department,
//       `Group:${GroupID}`, studentEmail, GroupID,
//     ];

//     db.query(surveyQuery, surveyParams, (err, surveyResults) => {
//       if (err) {
//         console.error("Error fetching surveys:", err);
//         return res.status(500).json({ error: "Database error", details: err.message });
//       }

//       // Fetch the GroupName for the student's GroupID
//       const groupQuery = `
//         SELECT GroupName 
//         FROM student_groups_info 
//         WHERE GroupID = ?
//       `;

//       db.query(groupQuery, [GroupID], (err, groupResults) => {
//         if (err) {
//           console.error("Error fetching group name:", err);
//           return res.status(500).json({ error: "Database error", details: err.message });
//         }

//         const GroupName = groupResults.length > 0 ? groupResults[0].GroupName : "No Group";

//         // Log the required details to the console
//         console.log("Student Email:", studentEmail);
//         console.log("Group Name:", GroupName);
//         surveyResults.forEach((survey) => {
//           console.log("Survey Title:", survey.survey_title);
//           console.log("Start Date:", survey.start_date);
//           console.log("End Date:", survey.end_date);
//         });

//         // Add GroupName to each survey result
//         const surveysWithGroup = surveyResults.map((survey) => ({
//           ...survey,
//           GroupName,
//         }));

//         res.json(surveysWithGroup); // Send the response with GroupName included
//       });
//     });
//   });
// }); 
app.get("/surveysuser", verifyToken, (req, res) => {
  const studentEmail = req.user.email;
  console.log("Fetching surveys for student:", studentEmail);

  // Query to get student details from student_groups
  const studentQuery = `SELECT Year, Department, GroupID FROM student_groups WHERE Email = ?`;

  db.query(studentQuery, [studentEmail], (err, studentResults) => {
    if (err) {
      console.error("Error fetching student details:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }

    if (studentResults.length === 0) {
      console.log("Student not found in student_groups. Checking studentdetails...");
      // If student is not found in student_groups, fetch from studentdetails
      const studentDetailsQuery = `SELECT Year, Department FROM studentdetails WHERE Email = ?`;

      db.query(studentDetailsQuery, [studentEmail], (err, studentDetailsResults) => {
        if (err) {
          console.error("Error fetching student details:", err);
          return res.status(500).json({ error: "Database error", details: err.message });
        }

        if (studentDetailsResults.length === 0) {
          return res.status(404).json({ error: "Student not found in database" });
        }

        const { Year, Department } = studentDetailsResults[0];
        fetchSurveys(studentEmail, Year, Department, null, res);
      });
    } else {
      const { Year, Department, GroupID } = studentResults[0];
      fetchSurveys(studentEmail, Year, Department, GroupID, res);
    }
  });
});

// Function to fetch surveys based on Year, Department, and GroupID
const fetchSurveys = (studentEmail, Year, Department, GroupID, res) => {
  console.log("Fetching surveys for:", { Year, Department, GroupID });

  const surveyQuery = `
    SELECT DISTINCT start_date, survey_title, staff_email, end_date, start_time, end_time, response_limit
    FROM permissions
    WHERE
      (assigned_roles = ? OR assigned_roles = ?)
      OR (assigned_roles = ? AND ? IN (SELECT Email FROM student_groups WHERE Year = ?))
      OR (assigned_roles = ? AND ? IN (SELECT Email FROM student_groups WHERE Department = ?))
      OR (assigned_roles = ? AND ? IN (SELECT Email FROM student_groups WHERE GroupID = ?))
  `;

  const surveyParams = [
    `Year:${Year}`, `Department:${Department}`,
    `Year:${Year}`, studentEmail, Year,
    `Department:${Department}`, studentEmail, Department,
    `Group:${GroupID}`, studentEmail, GroupID
  ];

  db.query(surveyQuery, surveyParams, (err, surveyResults) => {
    if (err) {
      console.error("Error fetching surveys:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }

    console.log("Surveys found:", surveyResults);

    // Function to format date to YYYY-MM-DD
    const formatDate = (dateString) => {
      const date = new Date(dateString);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    };

    // Combine start_date with start_time and end_date with end_time
    const formattedSurveys = surveyResults.map((survey) => {
      // Format start_date and end_date to YYYY-MM-DD
      const formattedStartDate = formatDate(survey.start_date);
      const formattedEndDate = formatDate(survey.end_date);

      // Ensure start_time and end_time are in HH:MM:SS format
      const startTime = survey.start_time ? survey.start_time : "00:00:00";
      const endTime = survey.end_time ? survey.end_time : "23:59:59";

      // Combine date and time into a valid ISO string
      const startDateTime = `${formattedStartDate}T${startTime}`;
      const endDateTime = `${formattedEndDate}T${endTime}`;

      // Validate the date strings
      const isValidStartDate = !isNaN(new Date(startDateTime).getTime());
      const isValidEndDate = !isNaN(new Date(endDateTime).getTime());

      if (!isValidStartDate || !isValidEndDate) {
        console.error("Invalid date format:", { startDateTime, endDateTime });
        return null; // Skip invalid entries
      }

      return {
        ...survey,
        start_date: new Date(startDateTime).toISOString(),
        end_date: new Date(endDateTime).toISOString(),
        response_limit: survey.response_limit || 1 // Ensure response_limit is at least 1
      };
    }).filter(survey => survey !== null); // Remove invalid entries

    // Fetch group name only if GroupID exists
    if (GroupID) {
      const groupQuery = `SELECT GroupName FROM student_groups_info WHERE GroupID = ?`;
      db.query(groupQuery, [GroupID], (err, groupResults) => {
        if (err) {
          console.error("Error fetching group name:", err);
          return res.status(500).json({ error: "Database error", details: err.message });
        }

        const GroupName = groupResults.length > 0 ? groupResults[0].GroupName : "No Group";
        console.log("Group Name:", GroupName);

        const surveysWithGroup = formattedSurveys.map((survey) => ({
          ...survey,
          GroupName,
        }));

        res.json(surveysWithGroup);
      });
    } else {
      res.json(formattedSurveys);
    }
  });
};

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

app.post("/creategroup", (req, res) => {
  const { groupName, students, staffemail } = req.body;

  if (!groupName || students.length === 0 || !staffemail) {
    return res.status(400).json({ error: "Group name, staff email, and students are required" });
  }

  // Insert group into student_groups_info with staffemail
  db.query(
    "INSERT INTO student_groups_info (GroupName, staffmail) VALUES (?, ?)",
    [groupName, staffemail],
    (err, result) => {
      if (err) {
        console.error("Error inserting group:", err);
        return res.status(500).json({ error: "Database error" });
      }

      const groupId = result.insertId;

      // Insert students into student_groups
      const studentData = students.map(({ Name, Year, Email, Department }) => [groupId, Name, Year, Email, Department]);

      db.query(
        "INSERT INTO student_groups (GroupID, Name, Year, Email, Department) VALUES ?",
        [studentData],
        (err) => {
          if (err) {
            console.error("Error inserting students:", err);
            return res.status(500).json({ error: "Failed to insert student details" });
          }

          res.json({ message: "Group created successfully!" });
        }
      );
    }
  );
});
app.get("/surveysuser", verifyToken, (req, res) => {
  const studentEmail = req.user.email;
  console.log("Fetching surveys for student:", studentEmail);

  // Query to get student details from student_groups
  const studentQuery = `SELECT Year, Department, GroupID FROM student_groups WHERE Email = ?`;

  db.query(studentQuery, [studentEmail], (err, studentResults) => {
    if (err) {
      console.error("Error fetching student details:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }

    if (studentResults.length === 0) {
      console.log("Student not found in student_groups. Checking studentdetails...");
      // If student is not found in student_groups, fetch from studentdetails
      const studentDetailsQuery = `SELECT Year, Department FROM studentdetails WHERE Email = ?`;

      db.query(studentDetailsQuery, [studentEmail], (err, studentDetailsResults) => {
        if (err) {
          console.error("Error fetching student details:", err);
          return res.status(500).json({ error: "Database error", details: err.message });
        }

        if (studentDetailsResults.length === 0) {
          return res.status(404).json({ error: "Student not found in database" });
        }

        const { Year, Department } = studentDetailsResults[0];
        fetchSurveys(studentEmail, Year, Department, null, res);
      });
    } else {
      const { Year, Department, GroupID } = studentResults[0];
      fetchSurveys(studentEmail, Year, Department, GroupID, res);
    }
  });
});



//   const { title } = req.params;

//   // Fetch questions based on survey title
//   db.query('SELECT * FROM questions WHERE survey_name = ?', [title], (err, questions) => {
//     if (err) {
//       console.error('Error fetching questions:', err);
//       return res.status(500).send('Internal Server Error');
//     }

//     // If no questions are found, return an empty array
//     if (questions.length === 0) {
//       return res.json([]);
//     }

//     // Fetch options for each question
//     const questionsWithOptions = [];
//     let completedQueries = 0;

//     questions.forEach((question, index) => {
//       db.query('SELECT * FROM options WHERE question_id = ?', [question.id], (err, options) => {
//         if (err) {
//           console.error('Error fetching options:', err);
//           return res.status(500).send('Internal Server Error');
//         }

//         // Add the question with its options to the array
//         questionsWithOptions.push({ ...question, options });

//         // Check if all queries are completed
//         completedQueries++;
//         if (completedQueries === questions.length) {
//           // Send the response with all questions and their options
//           res.json(questionsWithOptions);
//         }
//       });
//     });
//   });
// });

app.get('/surveyquestions/:title', (req, res) => {
  const { title } = req.params;

  db.query('SELECT * FROM questions WHERE survey_name = ?', [title], (err, questions) => {
    if (err) {
      console.error('Error fetching questions:', err);
      return res.status(500).send('Internal Server Error');
    }

    if (questions.length === 0) {
      return res.json([]);
    }

    const questionsWithOptions = [];
    let completedQueries = 0;

    questions.forEach((question, index) => {
      db.query('SELECT * FROM options WHERE question_id = ?', [question.id], (err, options) => {
        if (err) {
          console.error('Error fetching options:', err);
          return res.status(500).send('Internal Server Error');
        }

        // Shuffle options if shuffle_options is 1
        if (question.shuffle_answers === 1) {
          options = options.sort(() => Math.random() - 0.5);
        }

        console.log(`Question ${index + 1}:`, question);
        console.log(`Options before sending response:`, options);

        questionsWithOptions.push({ ...question, options });

        completedQueries++;
        if (completedQueries === questions.length) {
          console.log("Final response before sending:", questionsWithOptions);
          res.json(questionsWithOptions);
        }
      });
    });
  });
});
// Create a new survey
app.post('/create-survey', verifyToken, (req, res) => {
  const { survey_title, user_email } = req.body;
  const survey_id = require('uuid').v4();

  db.query(
    'INSERT INTO surveys (id, user_email, survey_title) VALUES (?, ?, ?)',
    [survey_id, user_email, survey_title],
    (err) => {
      if (err) {
        console.error('Error creating survey:', err);
        return res.status(500).json({ success: false, message: 'Failed to create survey' });
      }
      res.json({ success: true, survey_id });
    }
  );
});

// Add this to your backend code
app.post('/track-submission', verifyToken, (req, res) => {
  const { survey_title, student_email } = req.body;

  // Check if submission exists
  const checkQuery = `SELECT * FROM survey_submissions WHERE survey_title = ? AND student_email = ?`;
  db.query(checkQuery, [survey_title, student_email], (err, results) => {
    if (err) {
      console.error("Error checking submission:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }

    if (results.length > 0) {
      // Update existing submission count
      const updateQuery = `UPDATE survey_submissions SET submission_count = submission_count + 1 WHERE survey_title = ? AND student_email = ?`;
      db.query(updateQuery, [survey_title, student_email], (err) => {
        if (err) {
          console.error("Error updating submission:", err);
          return res.status(500).json({ error: "Database error", details: err.message });
        }
        res.json({ success: true });
      });
    } else {
      // Create new submission record
      const insertQuery = `INSERT INTO survey_submissions (survey_title, student_email, submission_count) VALUES (?, ?, 1)`;
      db.query(insertQuery, [survey_title, student_email], (err) => {
        if (err) {
          console.error("Error creating submission:", err);
          return res.status(500).json({ error: "Database error", details: err.message });
        }
        res.json({ success: true });
      });
    }
  });
});

// Add this to get submission count
app.get('/submission-count', verifyToken, (req, res) => {
  const { survey_title, student_email } = req.query;

  const query = `SELECT submission_count FROM survey_submissions WHERE survey_title = ? AND student_email = ?`;
  db.query(query, [survey_title, student_email], (err, results) => {
    if (err) {
      console.error("Error fetching submission count:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }

    const count = results.length > 0 ? results[0].submission_count : 0;
    res.json({ count });
  });
});

// Modify the save-response endpoint to handle updates
app.post('/save-response', verifyToken, (req, res) => {
  const { survey_id, question_text, response_text, selected_option, student_email, survey_title } = req.body;

  // First check if response exists
  const checkQuery = `SELECT * FROM survey_responses 
    WHERE survey_id = ? AND question_text = ? AND student_email = ? AND survey_title = ?`;
  
  db.query(checkQuery, [survey_id, question_text, student_email, survey_title], (err, results) => {
    if (err) {
      console.error("Error checking response:", err);
      return res.status(500).json({ error: "Database error", details: err.message });
    }

    if (results.length > 0) {
      // Update existing response
      const updateQuery = `UPDATE survey_responses 
        SET response_text = ?, selected_option = ?, updated_at = NOW() 
        WHERE survey_id = ? AND question_text = ? AND student_email = ? AND survey_title = ?`;
      
      db.query(updateQuery, [
        response_text, 
        selected_option, 
        survey_id, 
        question_text, 
        student_email,
        survey_title
      ], (err) => {
        if (err) {
          console.error("Error updating response:", err);
          return res.status(500).json({ error: "Database error", details: err.message });
        }
        res.json({ success: true });
      });
    } else {
      // Insert new response
      const insertQuery = `INSERT INTO survey_responses 
        (survey_id, question_text, response_text, selected_option, student_email, survey_title) 
        VALUES (?, ?, ?, ?, ?, ?)`;
      
      db.query(insertQuery, [
        survey_id, 
        question_text, 
        response_text, 
        selected_option, 
        student_email,
        survey_title
      ], (err) => {
        if (err) {
          console.error("Error saving response:", err);
          return res.status(500).json({ error: "Database error", details: err.message });
        }
        res.json({ success: true });
      });
    }
  });
});
app.get('/get-mentee-surveys', verifyToken, async (req, res) => {
  try {
    const staffEmail = req.user.email;
    console.log(`[DEBUG] Fetching surveys for mentor: ${staffEmail}`);

    // 1. Get all mentees of this mentor
    const [mentees] = await db.promise().query(
      'SELECT mentee_email FROM mentor_mentee WHERE mentor_email = ?',
      [staffEmail]
    );

    if (!mentees || mentees.length === 0) {
      console.log('[DEBUG] No mentees found for this mentor');
      return res.status(200).json([]);
    }

    const menteeEmails = mentees.map(m => m.mentee_email);
    console.log(`[DEBUG] Mentee emails: ${menteeEmails.join(', ')}`);

    // 2. Get mentees' year, department, and group info
    const [menteeDetails] = await db.promise().query(`
      SELECT s.Email, s.Year, s.Department, sg.GroupID, sgi.GroupName 
      FROM studentdetails s
      LEFT JOIN student_groups sg ON s.Email = sg.Email
      LEFT JOIN student_groups_info sgi ON sg.GroupID = sgi.GroupID
      WHERE s.Email IN (?)
    `, [menteeEmails]);

    if (!menteeDetails || menteeDetails.length === 0) {
      console.log('[DEBUG] No mentee details found');
      return res.status(200).json([]);
    }

    // Current date/time for live survey filtering
    const currentDate = new Date().toISOString().split('T')[0];
    const currentTime = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`[DEBUG] Current date: ${currentDate}, time: ${currentTime}`);

    // 3. Get all surveys that are currently live
    const [allLiveSurveys] = await db.promise().query(`
      SELECT * FROM permissions 
      WHERE start_date <= ?
      AND end_date >= ?
      AND (
        (start_date = end_date AND start_time <= ? AND end_time >= ?) 
        OR 
        (start_date != end_date)
      )
    `, [currentDate, currentDate, currentTime, currentTime]);

    console.log(`[DEBUG] Found ${allLiveSurveys.length} live surveys in system`);

    // 4. Filter surveys that match mentees' criteria
    const relevantSurveys = allLiveSurveys.filter(survey => {
      // Improved helper function to handle different input formats
      const safeParse = (input) => {
        if (!input || input === '[]') return [];
        
        // If it's already an array (some DB drivers might return parsed JSON)
        if (Array.isArray(input)) return input;
        
        // If it's a string that looks like a simple value (e.g., "Year:II")
        if (typeof input === 'string' && !input.startsWith('[') && !input.startsWith('{')) {
          return [input]; // Return as single-item array
        }
        
        // Try to parse as JSON
        try {
          return JSON.parse(input);
        } catch (e) {
          console.error(`Could not parse as JSON: ${input}. Treating as empty array.`);
          return [];
        }
      };

      // Get survey criteria
      const surveyYears = safeParse(survey.years);
      const surveyDepts = safeParse(survey.department);
      const surveyGroups = safeParse(survey.assigned_roles);

      // Check if survey has no restrictions (applies to all)
      if (surveyYears.length === 0 && surveyDepts.length === 0 && surveyGroups.length === 0) {
        return true;
      }

      // Check if any mentee matches survey criteria
      return menteeDetails.some(mentee => {
        // Check year/department criteria
        const yearMatch = surveyYears.length === 0 || surveyYears.some(y => 
          mentee.Year && mentee.Year.toString().includes(y.toString())
        );
        const deptMatch = surveyDepts.length === 0 || surveyDepts.some(d => 
          mentee.Department && mentee.Department.toString().includes(d.toString())
        );
        
        // Check group criteria
        const groupMatch = surveyGroups.length === 0 || 
                         (mentee.GroupName && surveyGroups.some(g => 
                           mentee.GroupName.toString().includes(g.toString())
                         ));
        
        return (yearMatch && deptMatch) || groupMatch;
      });
    });

    console.log(`[DEBUG] Found ${relevantSurveys.length} relevant surveys for mentees`);
    res.status(200).json(relevantSurveys);

  } catch (error) {
    console.error('[ERROR] in mentee surveys endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});