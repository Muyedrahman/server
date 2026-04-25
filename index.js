require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8",
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("blood-donationDB");
    const usersCollection = db.collection("users");
    const donationRequestCollection = db.collection("donationRequests");
    const fundsCollection = db.collection("funds");

    //signUp data ---> db
    app.post("/users", async (req, res) => {
      const user = req.body;
      const isExist = await usersCollection.findOne({ email: user.email });
      if (isExist) {
        return res.send({ message: "User already exists" });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });
    // get all users data from db
    app.get("/users", async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // create donation requestddd
    app.post("/donation-requests", async (req, res) => {
      const request = req.body;
      request.status = "pending";
      request.createdAt = new Date();

      const result = await donationRequestCollection.insertOne(request);
      res.send({ success: true, insertedId: result.insertedId });
    });
    // get donation requests (admin / filter)
    app.get("/donation-requests", async (req, res) => {
      const { email, status, limit } = req.query;

      let query = {};
      if (email) query.requesterEmail = email;
      if (status) query.status = status;

      let cursor = donationRequestCollection
        .find(query)
        .sort({ createdAt: -1 });

      if (limit) {
        cursor = cursor.limit(parseInt(limit));
      }

      const result = await cursor.toArray();
      res.send(result);
    });

    const { ObjectId } = require("mongodb");
    // donation details
    app.get("/donation-requests/:id", async (req, res) => {
      try {
        const { id } = req.params;

        const result = await donationRequestCollection.findOne({
          _id: new ObjectId(id),
        });

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to get donation request" });
      }
    });

    // Update user profile
   // =====================
app.patch("/users/:email", async (req, res) => {
  const { email } = req.params;
  const updateData = { ...req.body };

  // Prevent email update
  delete updateData.email;

  // Remove undefined or null fields to avoid overwriting
  Object.keys(updateData).forEach(
    (key) => updateData[key] === undefined && delete updateData[key]
  );

  try {
    const result = await usersCollection.updateOne(
      { email },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "User not found" });
    }

    res.send({ message: "Profile updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Server error" });
  }
});

    // donation & progress
    // PATCH /donation-requests/:id/donate
    app.patch("/donation-requests/:id/donate", verifyJWT, async (req, res) => {
      const { id } = req.params;

      try {
        const request = await donationRequestCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!request)
          return res
            .status(404)
            .send({ success: false, message: "Request not found" });

        if (request.status !== "pending")
          return res
            .status(400)
            .send({
              success: false,
              message: "Request already in progress or completed",
            });

        const updateData = {
          status: "inprogress",
          donorName: req.tokenEmail ? req.tokenEmail : "Anonymous",
          donorEmail: req.tokenEmail,
          donatedAt: new Date(),
        };

        const result = await donationRequestCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        res.send({ success: true, message: "Donation confirmed", result });
      } catch (err) {
        console.error(err);
        res
          .status(500)
          .send({ success: false, message: "Failed to confirm donation" });
      }
    });
    // =======================
    // PATCH (edit donation request)
    // =======================
    app.patch("/donation-requests/:id", async (req, res) => {
      const { id } = req.params;
      const updateData = req.body;

      delete updateData._id; // 

      try {
        const result = await donationRequestCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Request not found",
          });
        }

        res.send({
          success: true,
          message: "Donation request updated successfully",
        });
      } catch (err) {
        res.status(500).send({
          success: false,
          message: err.message, // 🔥 real error পাঠাও
        });
      }
    });

    // =======================
    // DELETE donation request
    // =======================
    app.delete("/donation-requests/:id", async (req, res) => {
      const { id } = req.params;
      try {
        const result = await donationRequestCollection.deleteOne({
          _id: new ObjectId(id),
        });
        if (result.deletedCount === 0) {
          return res
            .status(404)
            .send({ success: false, message: "Request not found" });
        }
        res.send({
          success: true,
          message: "Donation request deleted successfully",
        });
      } catch (err) {
        res.status(500).send({ success: false, message: err.message });
      }
    });

    // admin user block
    app.patch("/users/:id", async (req, res) => {
      const { id } = req.params;
      const updateData = req.body;
      try {
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        if (result.matchedCount === 0) {
          return res
            .status(404)
            .send({ success: false, message: "User not found" });
        }

        res.send({ success: true, message: "User updated successfully" });
      } catch (error) {
        res
          .status(500)
          .send({ success: false, message: "Server error", error });
      }
    });

    // get a user's role
    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });

    // Block/Unblock user
    app.patch("/users/:id/status", async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;

      try {
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );

        if (result.matchedCount === 0) {
          return res
            .status(404)
            .send({ success: false, message: "User not found" });
        }

        res.send({ success: true, message: "Status updated successfully" });
      } catch (error) {
        console.error(error);
        res.status(500).send({ success: false, message: "Server error" });
      }
    });

    // Change user role
    app.patch("/users/:id/role", async (req, res) => {
      const { id } = req.params;
      const { role } = req.body; // "volunteer" বা "admin"

      try {
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } }
        );

        if (result.matchedCount === 0) {
          return res
            .status(404)
            .send({ success: false, message: "User not found" });
        }

        res.send({ success: true, message: "Role updated successfully" });
      } catch (error) {
        console.error(error);
        res.status(500).send({ success: false, message: "Server error" });
      }
    });

    // =====================
    // JWT Middleware
    // =====================
    const verifyJWT1 = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized" });
      }

      const token = authHeader.split(" ")[1];

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.tokenEmail = decoded.email;
        next();
      } catch (error) {
        console.error("JWT Error:", error);
        res.status(401).send({ message: "Unauthorized" });
      }
    };

    // =====================
    // GET all funds
    // =====================
    app.get("/funds", verifyJWT1, async (req, res) => {
      try {
        const funds = await fundsCollection.find().sort({ date: -1 }).toArray();

        res.send(funds);
      } catch (error) {
        res.status(500).send({ message: "Failed to load funds" });
      }
    });

    // =====================
    // Stripe Checkout
    // =====================
    app.post("/create-checkout-session", verifyJWT1, async (req, res) => {
      const { amount, name, email } = req.body;

      if (!amount || amount < 1) {
        return res.status(400).send({ message: "Invalid amount" });
      }

      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: "Blood Donation Fund",
                },
                unit_amount: amount * 100,
              },
              quantity: 1,
            },
          ],
          success_url: `${process.env.CLIENT_DOMAIN}/payment-success?amount=${amount}&name=${name}&email=${email}`,
          
          cancel_url: `${process.env.CLIENT_DOMAIN}/funding`,
        });

        res.send({ url: session.url });
      } catch (error) {
        console.error("Stripe Error:", error);
        res.status(500).send({ message: "Stripe session failed" });
      }
    });

    // =====================
    // Save fund after success
    // =====================
    app.post("/funds", verifyJWT1, async (req, res) => {
      const { name, email, amount } = req.body;

      try {
        const fund = {
          name,
          email,
          amount: Number(amount),
          date: new Date(),
        };

        const result = await fundsCollection.insertOne(fund);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to save fund" });
      }
    });

// susscess
app.post("/funds", verifyJWT, async (req, res) => {
  const { name, email, amount } = req.body;

  const fund = {
    name,
    email,
    amount: Number(amount),
    date: new Date(),
  };

  await fundsCollection.insertOne(fund);
  res.send({ success: true });
});











    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
