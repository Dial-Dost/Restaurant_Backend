import { Sequelize, DataTypes } from "sequelize";

const sequelize = new Sequelize({
    dialect: "sqlite",
    storage: "./test_restaurant.db",
    logging: false,
});

const Customer = sequelize.define(
    "Customer",
    {
        customer_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            primaryKey: true,
            autoIncrement: true,
            field: "customer_id",
        },
        name: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        phone_number: {
            type: DataTypes.STRING(15),
            allowNull: false,
        },
        email: {
            type: DataTypes.STRING,
            allowNull: true,
        },
    },
    {
        tableName: "Customers",
        timestamps: false,
    },
);

const Table = sequelize.define(
    "Table",
    {
        table_name: {
            type: DataTypes.STRING,
            allowNull: false,
            primaryKey: true,
        },
        capacity: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
    },
    {
        timestamps: false,
        tableName: "Tables",
    },
);

const Booking = sequelize.define(
    "Booking",
    {
        booking_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            primaryKey: true,
            autoIncrement: true,
            field: 'booking_id',
        },
        customer_id: {
            type: DataTypes.INTEGER,
            references: {
                model: Customer,
                key: "customer_id",
            },
            unique: false,
        },
        table_name: {
            type: DataTypes.STRING,
            references: {
                model: Table,
                key: "table_name",
            },
            unique: false,
        },
        booking_date_time: {
            type: DataTypes.DATE,
            allowNull: false,
        },
        duration_mins: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        number_of_people: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        source: {
            type: DataTypes.STRING,
        },
        from: {
            type: DataTypes.STRING,
            allowNull: true,
        }
    },
    {
        tableName: "Bookings",
        timestamps: false,
    },
);

Customer.hasMany(Booking, {
    foreignKey: {
        name: "customer_id",
    },
});

Booking.belongsTo(Customer, {
    foreignKey: {
        name: "customer_id",
    },
});

Table.hasMany(Booking, {
    foreignKey: {
        name: "table_name",
    },
})

Booking.belongsTo(Table, {
    foreignKey: {
        name: "table_name",
    },
})

try {
    await sequelize.sync();
    console.log("Database synchronized!");
} catch (error) {
    console.error("Error synchronizing the database:", error);
}

export { sequelize, Customer, Booking, Table};
