import { Model, Op } from "sequelize";
import { Booking, Customer, sequelize, Table } from "./schema.ts";

function AddCustomer(
	name: string,
	number: string,
	email?: string,
): Promise<Model> {
	const newCustomer = Customer.create({
		name: name,
		phone_number: number,
		email: email,
	});
	return newCustomer;
}

function AddTable(table_name: string, capacity?: number): Promise<Model> {
	const newCustomer = Table.create({
		table_name: table_name,
		capacity: capacity,
	});
	return newCustomer;
}

function AddBooking(
	customer_id: number,
	table_name: number,
	booking_date_time: Date,
	duration: number,
	number_of_people: number,
): Promise<Model> {
	const newBooking = Booking.create({
		customer_id: customer_id,
		table_name: table_name,
		booking_date_time: booking_date_time,
		duration_mins: duration,
		number_of_people: number_of_people,
	});

	return newBooking;
}

async function GetCustomerId(
	name: string,
	number: string,
): Promise<number | null> {
	try {
		const customers = await Customer.findAll({
			where: {
				[Op.and]: [
					sequelize.where(
						sequelize.fn("lower", sequelize.col("name")),
						name.toLowerCase(),
					),
					{ phone_number: number },
				],
			},
		});

		if (customers.length == 0) {
			return null;
		}
		if (customers.length > 1) {
			console.warn(
				"Error: multiple customers with same number and same name detected",
			);
			console.log(customers.map((x) => x.dataValues));
		}
		return customers[0]?.dataValues.customer_id;
	} catch (error) {
		console.error("Error finding customer:", error);
		return null;
	}
}

async function AddEmailToCustomer(cust_id: number, email: string) {
	try {
		let customer = await Customer.findByPk(cust_id);
		if (customer == null) {
			return null;
		}
		if (customer.dataValues.email == null) {
			customer.update({ email: email });
		}
	} catch (error) {
		console.log("error adding email to customer", cust_id);
		console.log(error);
		return null;
	}
}

export { GetCustomerId, AddCustomer, AddEmailToCustomer, AddTable, AddBooking };
