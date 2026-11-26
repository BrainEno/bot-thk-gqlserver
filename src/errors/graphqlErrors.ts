import { GraphQLError } from 'graphql'

export class ApolloError extends GraphQLError {
    constructor(message: string, code = 'INTERNAL_SERVER_ERROR') {
        super(message, { extensions: { code } })
        this.name = 'ApolloError'
    }
}

export class AuthenticationError extends ApolloError {
    constructor(message: string) {
        super(message, 'UNAUTHENTICATED')
        this.name = 'AuthenticationError'
    }
}

export class UserInputError extends ApolloError {
    constructor(message: string) {
        super(message, 'BAD_USER_INPUT')
        this.name = 'UserInputError'
    }
}
