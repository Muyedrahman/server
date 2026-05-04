require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT || 3000;
const app = express();

console.log("STRIPE KEY:", process.env.STRIPE_SECRET_KEY);
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8",
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

//  Middleware 
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  }),
);
app.use(express.json());



//   verifyJWT 
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized Access!" });
  }
};

// MongoDB
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

   
    // USER ROUTES
    
    //  Register
    app.post("/users", async (req, res) => {
      const user = req.body;
      const isExist = await usersCollection.findOne({ email: user.email });
      if (isExist) return res.send({ message: "User already exists" });
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    //  Get all users 
    app.get("/users", async (req, res) => {
      const { status } = req.query;
      const query = status ? { status } : {};
      const result = await usersCollection.find(query).toArray();
      res.send(result);
    });
    //  ADD THIS HERE 
    app.get("/users/:email", async (req, res) => {
      const user = await usersCollection.findOne({
        email: req.params.email,
      });
      res.send(user);
    });

    //  Get user role
    app.get("/user/role", verifyJWT, async (req, res) => {
      try {
        const user = await usersCollection.findOne({
          email: req.tokenEmail,
        });

        const role = user?.role || "donor";

        res.send({ role });
      } catch (error) {
        res.status(500).send({ role: "donor", message: "Server error" });
      }
    });


    //  Update profile 
    app.patch("/users/update/:email", async (req, res) => {
      const { email } = req.params;
      const updateData = { ...req.body };
      delete updateData.email;
      const result = await usersCollection.updateOne(
        { email },
        { $set: updateData },
      );
      res.send(result);
    });

    //  Block/Unblock user id 
    app.patch("/users/:id/status", async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } },
      );
      res.send(result);
    });

    //  Change user role id 
    app.patch("/users/:id/role", async (req, res) => {
      const { id } = req.params;
      const { role } = req.body;
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } },
      );
      res.send(result);
    });

   
    // DONATION REQUEST ROUTES
   
    //1.xs  Create donation request
    app.post("/donation-requests", async (req, res) => {
      const request = req.body;

      //  Blocked user C
      const user = await usersCollection.findOne({
        email: request.requesterEmail,
      });
      if (user?.status === "blocked") {
        return res.status(403).send({
          message: "Blocked user cannot create request",
        });
      }

      request.status = "pending";
      request.createdAt = new Date();
      const result = await donationRequestCollection.insertOne(request);
      res.send(result);
    });
    

    //2.  Get all donation requests 
    app.get("/donation-requests", async (req, res) => {
      const { email, status, limit } = req.query;
      let query = {};
      
      if (email) query.requesterEmail = email;
      if (status) query.status = status;
      let cursor = donationRequestCollection
        .find(query)
        .sort({ createdAt: -1 });
      if (limit) cursor = cursor.limit(parseInt(limit));
      const result = await cursor.toArray();
      res.send(result);
    });

    //3. XS1  Donor  requests
    app.get("/donation-requests/my", async (req, res) => {
      const { email, limit } = req.query;
      const query = { requesterEmail: email };
      let cursor = donationRequestCollection
        .find(query)
        .sort({ createdAt: -1 });
      if (limit) cursor = cursor.limit(parseInt(limit));
      const result = await cursor.toArray();
      res.send(result);
    });


    //4.  Get single donation request 
    app.get("/donation-requests/:id", async (req, res) => {
      const { id } = req.params;
      const result = await donationRequestCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    //5.  Edit donation request
    app.patch("/donation-requests/:id", async (req, res) => {
      const { id } = req.params;
      const updateData = { ...req.body };
      delete updateData._id;
      const result = await donationRequestCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updateData },
      );
      res.send(result);
    });

    //6. Donate pending --->inprogress
    app.patch("/donation-requests/:id/donate", verifyJWT, async (req, res) => {
      const { id } = req.params;
      const { donorName, donorEmail } = req.body;
      const result = await donationRequestCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status: "inprogress",
            donorName,
            donorEmail,
            donatedAt: new Date(),
          },
        },
      );
      res.send(result);
    });

    // 7. Delete donation request
    app.delete("/donation-requests/:id", async (req, res) => {
      const { id } = req.params;
      const result = await donationRequestCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });


    // FUNDING ROUTES

    //  Get all funds
    app.get("/funds", verifyJWT, async (req, res) => {
      const funds = await fundsCollection.find().sort({ date: -1 }).toArray();
      res.send(funds);
    });

    //  Save fund -->payment success  call 
    app.post("/funds", verifyJWT, async (req, res) => {
      const { name, email, amount } = req.body;
      const fund = {
        name,
        email,
        amount: Number(amount),
        date: new Date(),
      };
      const result = await fundsCollection.insertOne(fund);
      res.send(result);
    });

    //  Stripe Checkout Session
    app.post("/create-checkout-session", verifyJWT, async (req, res) => {
      const { amount, name, email } = req.body;
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Blood Donation Fund" },
              unit_amount: amount * 100,
            },
            quantity: 1,
          },
        ],
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?amount=${amount}&name=${name}&email=${email}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/dashboard/funding`,
      });
      res.send({ url: session.url });
    });



    // STATISTICS (Admin/Volunteer)

    //  Admin Dashboard Stats
    app.get("/statistics", verifyJWT, async (req, res) => {
      const totalUsers = await usersCollection.countDocuments({
        role: "donor",
      });
      const totalRequests = await donationRequestCollection.countDocuments();
      const funds = await fundsCollection.find().toArray();
      const totalFunding = funds.reduce((sum, f) => sum + f.amount, 0);
      res.send({ totalUsers, totalRequests, totalFunding });
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB!");
  } finally {
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Blood Donation Server Running!");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
       



